package authorization

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

var ErrInstallationTicket = errors.New("installation ticket is invalid, expired, or consumed")

type OnboardingRequest struct {
	Kind           string   `json:"kind"`
	Name           string   `json:"name"`
	Email          string   `json:"email,omitempty"`
	VehicleID      string   `json:"vehicle_id,omitempty"`
	VehicleNumber  string   `json:"vehicle_number,omitempty"`
	Role           Role     `json:"role,omitempty"`
	Scope          Scope    `json:"scope,omitempty"`
	VehicleIDs     []string `json:"vehicle_ids,omitempty"`
	IdempotencyKey string   `json:"idempotency_key"`
}

type OnboardingOperation struct {
	ID                   string            `json:"id"`
	Kind                 string            `json:"kind"`
	Name                 string            `json:"name"`
	Email                string            `json:"email,omitempty"`
	VehicleID            string            `json:"vehicle_id,omitempty"`
	Status               string            `json:"status"`
	Stage                string            `json:"stage"`
	ErrorCode            string            `json:"error_code"`
	UserID               string            `json:"user_id,omitempty"`
	CreatedAt            time.Time         `json:"created_at"`
	OrganizationID       string            `json:"-"`
	ActorUserID          string            `json:"-"`
	PlannedIdentityID    string            `json:"-"`
	ProviderName         string            `json:"-"`
	ClientID             string            `json:"-"`
	CredentialCiphertext []byte            `json:"-"`
	Request              OnboardingRequest `json:"-"`
	Attempts             int               `json:"-"`
}

func normalizeOnboarding(r OnboardingRequest) (OnboardingRequest, error) {
	if !validText(r.Name, 200) {
		return r, ErrInvalidRegistration
	}
	if _, err := canonicalUUID(r.IdempotencyKey); err != nil {
		return r, ErrInvalidRegistration
	}
	switch r.Kind {
	case "person":
		if r.Scope == "" {
			r.Scope = ScopeNone
		}
		address, err := mail.ParseAddress(r.Email)
		if err != nil || address.Address != r.Email || !validText(r.Email, 254) || r.VehicleID != "" || r.VehicleNumber != "" {
			return r, ErrInvalidRegistration
		}
		r.Email = strings.ToLower(r.Email)
		if r.Role != RoleViewer && r.Role != RoleRemoteOperator && r.Role != RoleOrgAdmin {
			return r, ErrInvalidAssignment
		}
		if len(r.VehicleIDs) > 128 || (r.Role == RoleOrgAdmin && r.Scope != ScopeAll) {
			return r, ErrInvalidAssignment
		}
		a, err := normalizeAssignment(Assignment{ActorUserID: uuid.NewString(), UserID: uuid.NewString(), OrganizationID: uuid.NewString(), Role: r.Role, Scope: r.Scope, VehicleIDs: r.VehicleIDs})
		if err != nil {
			return r, err
		}
		r.VehicleIDs = a.VehicleIDs
		sort.Strings(r.VehicleIDs)
	case "vehicle":
		if r.VehicleNumber != "" {
			r.VehicleNumber = strings.ToLower(strings.TrimSpace(r.VehicleNumber))
			if len(r.VehicleNumber) > 24 || !validVehicleID(r.VehicleNumber) || r.VehicleID != "" {
				return r, ErrInvalidRegistration
			}
		} else if !validVehicleID(r.VehicleID) || r.VehicleID == "*" {
			return r, ErrInvalidRegistration
		}
		if r.Email != "" || r.Role != "" || r.Scope != "" || len(r.VehicleIDs) != 0 {
			return r, ErrInvalidRegistration
		}
	default:
		return r, ErrInvalidRegistration
	}
	return r, nil
}

func onboardingRoleAllowed(ctx context.Context, tx *sql.Tx, actor string, request OnboardingRequest) error {
	if request.Role != RoleOrgAdmin {
		return nil
	}
	var platform bool
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1 AND status='active'`, actor).Scan(&platform); err != nil {
		return ErrNotOrganizationAdmin
	}
	if !platform {
		return ErrIdentityBindingRestricted
	}
	return nil
}

// CreateOnboarding durably reserves the provider identity before any network
// request. Every resume reconciles that exact immutable identity, never email.
func (s *Store) CreateOnboarding(ctx context.Context, actor, org string, request OnboardingRequest, ciphertext []byte) (OnboardingOperation, error) {
	r, err := normalizeOnboarding(request)
	if err != nil {
		return OnboardingOperation{}, err
	}
	if r.Kind == "vehicle" && (len(ciphertext) < 28 || len(ciphertext) > 4096) {
		return OnboardingOperation{}, ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	if err := onboardingRoleAllowed(ctx, tx, actor, r); err != nil {
		return OnboardingOperation{}, err
	}
	payload, _ := json.Marshal(r)
	prior, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE org_id=$1 AND idempotency_key=$2`, org, r.IdempotencyKey))
	if err == nil {
		previous, _ := json.Marshal(prior.Request)
		if string(previous) != string(payload) || prior.ActorUserID != actor {
			return OnboardingOperation{}, ErrConflict
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return OnboardingOperation{}, err
	}
	for _, id := range r.VehicleIDs {
		active, err := activeVehicle(ctx, tx, org, id)
		if err != nil {
			return OnboardingOperation{}, err
		}
		if !active {
			return OnboardingOperation{}, ErrInactiveLifecycle
		}
	}
	if r.Kind == "vehicle" {
		var exists bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_vehicles WHERE vehicle_id=$1)`, r.VehicleID).Scan(&exists); err != nil {
			return OnboardingOperation{}, err
		}
		if exists {
			return OnboardingOperation{}, ErrConflict
		}
	}
	id, identity := uuid.NewString(), uuid.NewString()
	vehicleID := r.VehicleID
	if r.Kind == "vehicle" && r.VehicleNumber != "" {
		vehicleID = "v-" + strings.ReplaceAll(org, "-", "")[:8] + "-" + r.VehicleNumber + "-" + strings.ReplaceAll(id, "-", "")[:16]
	}
	providerName := "teleop-" + id
	clientID := ""
	if r.Kind == "vehicle" {
		clientID = "teleop-device-" + id
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO authz_onboarding_operations
		(operation_id,org_id,actor_user_id,idempotency_key,request,kind,name,email,vehicle_id,planned_identity_id,provider_name,client_id,credential_ciphertext)
		VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)`,
		id, org, actor, r.IdempotencyKey, string(payload), r.Kind, r.Name, r.Email, vehicleID, identity, providerName, clientID, ciphertext)
	if err != nil {
		return OnboardingOperation{}, mutationError(err)
	}
	if err := onboardingEvent(ctx, tx, id, "planned", ""); err != nil {
		return OnboardingOperation{}, err
	}
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1`, id))
	if err != nil {
		return op, err
	}
	return op, mutationError(tx.Commit())
}

const onboardingSelect = `SELECT operation_id,org_id,actor_user_id,kind,name,email,vehicle_id,planned_identity_id,provider_name,client_id,
	credential_ciphertext,CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE status END,stage,error_code,COALESCE(user_id::text,''),created_at,request,attempts FROM authz_onboarding_operations`

func scanOnboarding(row interface{ Scan(...any) error }) (OnboardingOperation, error) {
	var op OnboardingOperation
	var request []byte
	err := row.Scan(&op.ID, &op.OrganizationID, &op.ActorUserID, &op.Kind, &op.Name, &op.Email, &op.VehicleID, &op.PlannedIdentityID,
		&op.ProviderName, &op.ClientID, &op.CredentialCiphertext, &op.Status, &op.Stage, &op.ErrorCode, &op.UserID, &op.CreatedAt, &request, &op.Attempts)
	if err == nil {
		err = json.Unmarshal(request, &op.Request)
	}
	return op, err
}

func (s *Store) GetOnboarding(ctx context.Context, actor, org, id string) (OnboardingOperation, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return OnboardingOperation{}, err
	}
	if !allowed {
		return OnboardingOperation{}, ErrNotOrganizationAdmin
	}
	op, err := scanOnboarding(s.db.QueryRowContext(ctx, onboardingSelect+` WHERE org_id=$1 AND operation_id=$2`, org, id))
	if errors.Is(err, sql.ErrNoRows) {
		return op, ErrConflict
	}
	return op, err
}

func (s *Store) ListOnboarding(ctx context.Context, actor, org string) ([]OnboardingOperation, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrNotOrganizationAdmin
	}
	rows, err := s.db.QueryContext(ctx, onboardingSelect+` WHERE org_id=$1 ORDER BY created_at DESC LIMIT 100`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ops := []OnboardingOperation{}
	for rows.Next() {
		op, err := scanOnboarding(rows)
		if err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	return ops, rows.Err()
}

func (s *Store) NextOnboarding(ctx context.Context) (OnboardingOperation, error) {
	return scanOnboarding(s.db.QueryRowContext(ctx, onboardingSelect+` WHERE cancelled_at IS NULL AND (status='pending' AND attempts<3 OR status='running') AND next_attempt_at<=now() ORDER BY created_at LIMIT 1`))
}

// StartOnboarding persists the unknown-result recovery stage before calling
// Casdoor or SMTP. A process restart resumes the same immutable plan.
func (s *Store) StartOnboarding(ctx context.Context, id string) error {
	op, err := scanOnboarding(s.db.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1`, id))
	if err != nil {
		return err
	}
	tx, _, err := s.managementTx(ctx, op.ActorUserID, op.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := onboardingRoleAllowed(ctx, tx, op.ActorUserID, op.Request); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status='running',attempts=attempts+1,
		stage=CASE WHEN stage='planned' THEN 'provider' ELSE stage END,error_code='',updated_at=now(),
		next_attempt_at=now()+interval '10 seconds' WHERE operation_id=$1 AND status IN ('pending','running') AND attempts<3 AND cancelled_at IS NULL`, id)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if err := onboardingEvent(ctx, tx, id, "attempt_started", ""); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) FailOnboarding(ctx context.Context, id, code string) error {
	if !validOnboardingError(code) {
		return ErrInvalidRegistration
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,
		error_code=$2,updated_at=now(),next_attempt_at=now()+CASE WHEN stage='invitation' THEN interval '70 seconds' ELSE interval '10 seconds' END
		WHERE operation_id=$1 AND status='running'`, id, code)
	if err != nil {
		return err
	}
	if err := onboardingEvent(ctx, tx, id, "attempt_failed", code); err != nil {
		return err
	}
	return tx.Commit()
}

func validOnboardingError(code string) bool {
	switch code {
	case "PROVIDER_UNAVAILABLE", "PROVIDER_CONFLICT", "PROVIDER_REJECTED", "INVITATION_UNAVAILABLE", "AUTHORIZATION_CHANGED", "BINDING_CONFLICT", "CONFIGURATION_INVALID":
		return true
	}
	return false
}

func (s *Store) RejectOnboardingAuthorization(ctx context.Context, id string) error {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status='failed',error_code='AUTHORIZATION_CHANGED',updated_at=now()
			WHERE operation_id=$1 AND status IN ('pending','running')`, id); err != nil {
		return err
	}
	if err := onboardingEvent(ctx, tx, id, "authorization_rejected", "AUTHORIZATION_CHANGED"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) RetryOnboarding(ctx context.Context, actor, org, id string) (OnboardingOperation, error) {
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE org_id=$1 AND operation_id=$2 FOR UPDATE`, org, id))
	if err != nil {
		return op, ErrConflict
	}
	// Do not transfer a stale plan to a different administrator.
	var cancelled bool
	if err := tx.QueryRowContext(ctx, `SELECT cancelled_at IS NOT NULL FROM authz_onboarding_operations WHERE operation_id=$1`, id).Scan(&cancelled); err != nil {
		return op, err
	}
	if cancelled || op.ActorUserID != actor || op.Status != "failed" {
		return op, ErrConflict
	}
	if err := onboardingRoleAllowed(ctx, tx, actor, op.Request); err != nil {
		return op, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status='pending',attempts=0,error_code='',next_attempt_at=now(),updated_at=now() WHERE operation_id=$1`, id)
	if err != nil {
		return op, err
	}
	if err := onboardingEvent(ctx, tx, id, "retry_requested", ""); err != nil {
		return op, err
	}
	op.Status, op.ErrorCode, op.Attempts = "pending", "", 0
	return op, tx.Commit()
}

func onboardingEvent(ctx context.Context, tx *sql.Tx, id, event, code string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO authz_onboarding_events(event_id,operation_id,event_type,error_code) VALUES($1,$2,$3,$4)`, uuid.NewString(), id, event, code)
	return err
}

// BindOnboarding is strictly fresh-only: identity, membership and first grant
// commit together. Existing principals are never adopted or rebound.
func (s *Store) BindOnboarding(ctx context.Context, op OnboardingOperation, issuer, subject string) error {
	tx, version, err := s.managementTx(ctx, op.ActorUserID, op.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	current, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1 FOR UPDATE`, op.ID))
	if err != nil {
		return err
	}
	var cancelled bool
	if err := tx.QueryRowContext(ctx, `SELECT cancelled_at IS NOT NULL FROM authz_onboarding_operations WHERE operation_id=$1`, op.ID).Scan(&cancelled); err != nil {
		return err
	}
	if cancelled || current.Stage != "provider" || current.Status != "running" || current.PlannedIdentityID != op.PlannedIdentityID || !validText(issuer, 2048) {
		return ErrConflict
	}
	op = current
	if err := onboardingRoleAllowed(ctx, tx, op.ActorUserID, op.Request); err != nil {
		return err
	}
	if op.Kind == "person" {
		if subject != op.PlannedIdentityID || op.ActorUserID == subject {
			return ErrSelfAssignment
		}
		for _, id := range op.Request.VehicleIDs {
			active, err := activeVehicle(ctx, tx, op.OrganizationID, id)
			if err != nil {
				return err
			}
			if !active {
				return ErrInactiveLifecycle
			}
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_users(user_id,name,status) VALUES($1,$2,'active')`, op.PlannedIdentityID, op.Name); err != nil {
			return mutationError(err)
		}
		if err := insertUserBinding(ctx, tx, issuer, subject, op.PlannedIdentityID); err != nil {
			return mutationError(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_organization_memberships(org_id,user_id,status) VALUES($1,$2,'active')`, op.OrganizationID, op.PlannedIdentityID); err != nil {
			return mutationError(err)
		}
		a := Assignment{ActorUserID: op.ActorUserID, UserID: op.PlannedIdentityID, OrganizationID: op.OrganizationID, Role: op.Request.Role, Scope: op.Request.Scope, VehicleIDs: op.Request.VehicleIDs}
		if err := replaceUserAssignment(ctx, tx, a, assignmentRules(a, "grant:"+uuid.NewString())); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET user_id=$2,stage='invitation',attempts=1,updated_at=now() WHERE operation_id=$1`, op.ID, op.PlannedIdentityID); err != nil {
			return err
		}
	} else {
		if subject != "admin/"+op.ProviderName {
			return ErrInvalidRegistration
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_vehicles(vehicle_id,org_id,name,status) VALUES($1,$2,$3,'active')`, op.VehicleID, op.OrganizationID, op.Name); err != nil {
			return mutationError(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_identity_subjects(issuer,subject,identity_kind) VALUES($1,$2,'vehicle')`, issuer, subject); err != nil {
			return mutationError(err)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_vehicle_identities(vehicle_id,issuer,subject,client_id,binding_version,status,secret_reference)
			VALUES($1,$2,$3,$4,1,'active',$5)`, op.VehicleID, issuer, subject, op.ClientID, "onboarding:"+op.ID); err != nil {
			return mutationError(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status='awaiting_install',stage='installation',error_code='',updated_at=now() WHERE operation_id=$1`, op.ID); err != nil {
			return err
		}
	}
	if err := onboardingEvent(ctx, tx, op.ID, "identity_bound", ""); err != nil {
		return err
	}
	return commitManagement(ctx, tx, version, op.ActorUserID, op.OrganizationID, "", "onboarding_bound", map[string]string{"operation_id": op.ID, "kind": op.Kind})
}

func (s *Store) CompleteInvitation(ctx context.Context, op OnboardingOperation) error {
	tx, _, err := s.managementTx(ctx, op.ActorUserID, op.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status='completed',stage='completed',error_code='',updated_at=now()
		WHERE operation_id=$1 AND kind='person' AND stage='invitation' AND status='running' AND cancelled_at IS NULL`, op.ID)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	if err := onboardingEvent(ctx, tx, op.ID, "invitation_sent", ""); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) MachineAudienceAllowed(ctx context.Context, issuer, subject string, audiences []string) (bool, error) {
	if len(audiences) == 0 || len(audiences) > 16 || len(issuer) > 2048 || len(subject) > 512 {
		return false, nil
	}
	v, err := s.ResolveVehicle(ctx, issuer, subject)
	if errors.Is(err, ErrUnknownIdentity) {
		v, err = s.ResolveInstallingVehicle(ctx, issuer, subject)
		if errors.Is(err, ErrUnknownIdentity) {
			return false, nil
		}
	}
	if err != nil {
		return false, err
	}
	if v.ClientID == "" {
		return false, nil
	}
	for _, a := range audiences {
		if a == v.ClientID {
			return true, nil
		}
	}
	return false, nil
}

// PrepareInstallationRotation invalidates every older ticket before an
// external credential update. A crash can only require another rotation.
func (s *Store) PrepareInstallationRotation(ctx context.Context, actor, org, id string, ciphertext []byte) (OnboardingOperation, error) {
	if len(ciphertext) < 28 || len(ciphertext) > 4096 {
		return OnboardingOperation{}, ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1 AND org_id=$2 AND cancelled_at IS NULL FOR UPDATE`, id, org))
	if err != nil || op.Kind != "vehicle" || op.Status != "awaiting_install" {
		return op, ErrConflict
	}
	if _, err = tx.ExecContext(ctx, `UPDATE authz_installation_tickets SET revoked_at=now() WHERE operation_id=$1 AND revoked_at IS NULL`, id); err != nil {
		return op, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET credential_ciphertext=$2,updated_at=now() WHERE operation_id=$1`, id, ciphertext); err != nil {
		return op, err
	}
	if err := onboardingEvent(ctx, tx, id, "credential_rotation_planned", ""); err != nil {
		return op, err
	}
	op.CredentialCiphertext = ciphertext
	return op, tx.Commit()
}

func (s *Store) CreateInstallationTicket(ctx context.Context, actor, org, id string, tokenHash [sha256.Size]byte, expires time.Time) error {
	if !expires.After(time.Now()) || expires.After(time.Now().Add(10*time.Minute)) {
		return ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var awaiting bool
	if err := tx.QueryRowContext(ctx, `SELECT kind='vehicle' AND status='awaiting_install' AND cancelled_at IS NULL FROM authz_onboarding_operations WHERE org_id=$1 AND operation_id=$2 FOR UPDATE`, org, id).Scan(&awaiting); err != nil || !awaiting {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_installation_tickets(token_hash,operation_id,expires_at) VALUES($1,$2,$3)`, tokenHash[:], id, expires); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET error_code='',updated_at=now() WHERE operation_id=$1`, id); err != nil {
		return err
	}
	if err := onboardingEvent(ctx, tx, id, "installation_ticket_issued", ""); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) FailInstallationRotation(ctx context.Context, id, code string) error {
	if !validOnboardingError(code) {
		return ErrInvalidRegistration
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET error_code=$2,updated_at=now()
		WHERE operation_id=$1 AND status='awaiting_install' AND kind='vehicle'`, id, code); err != nil {
		return err
	}
	if err := onboardingEvent(ctx, tx, id, "credential_rotation_failed", code); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) InstallationTicketOrganization(ctx context.Context, hash [sha256.Size]byte) (string, error) {
	var org string
	err := s.db.QueryRowContext(ctx, `SELECT o.org_id FROM authz_installation_tickets t JOIN authz_onboarding_operations o USING(operation_id)
		WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()`, hash[:]).Scan(&org)
	if errors.Is(err, sql.ErrNoRows) {
		return s.RotationTicketOrganization(ctx, hash)
	}
	return org, err
}

func (s *Store) ConsumeInstallationTicket(ctx context.Context, hash [sha256.Size]byte) (OnboardingOperation, error) {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `UPDATE authz_installation_tickets t SET consumed_at=now()
		FROM authz_onboarding_operations op,authz_organizations org,authz_vehicles v,authz_vehicle_identities i
		WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()
		AND op.operation_id=t.operation_id AND op.status='awaiting_install' AND op.kind='vehicle' AND op.cancelled_at IS NULL
		AND org.org_id=op.org_id AND org.status='active' AND v.vehicle_id=op.vehicle_id AND v.org_id=op.org_id AND v.status='active'
		AND i.vehicle_id=v.vehicle_id AND i.status='active' AND i.client_id=op.client_id
		RETURNING t.operation_id`, hash[:]).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		tx.Rollback()
		return s.ConsumeRotationTicket(ctx, hash)
	}
	if err != nil {
		return OnboardingOperation{}, err
	}
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1`, id))
	if err != nil {
		return op, err
	}
	if err := onboardingEvent(ctx, tx, id, "installation_ticket_consumed", ""); err != nil {
		return op, err
	}
	return op, tx.Commit()
}

func (s *Store) CompleteInstallation(ctx context.Context, issuer, vehicleID string) error {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `UPDATE authz_onboarding_operations op SET status='completed',stage='completed',error_code='',credential_ciphertext=NULL,updated_at=now()
		FROM authz_vehicle_identities i,authz_vehicles v,authz_organizations o
		WHERE op.vehicle_id=$1 AND op.kind='vehicle' AND op.status IN ('awaiting_install','completed') AND op.cancelled_at IS NULL
		AND i.vehicle_id=op.vehicle_id AND i.issuer=$2 AND i.client_id=op.client_id AND i.status='active'
		AND v.vehicle_id=i.vehicle_id AND v.status='active' AND o.org_id=v.org_id AND o.status='active'
		AND EXISTS(SELECT 1 FROM authz_installation_tickets t WHERE t.operation_id=op.operation_id AND t.consumed_at IS NOT NULL AND t.revoked_at IS NULL)
		RETURNING op.operation_id`, vehicleID, issuer).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownIdentity
	}
	if err != nil {
		return err
	}
	if err := onboardingEvent(ctx, tx, id, "installation_auth_verified", ""); err != nil {
		return err
	}
	return tx.Commit()
}
