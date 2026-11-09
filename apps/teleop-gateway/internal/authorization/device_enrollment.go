package authorization

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"time"

	"github.com/google/uuid"
)

var (
	ErrEnrollmentInvalid       = errors.New("device enrollment is invalid or unavailable")
	ErrEnrollmentReplay        = errors.New("device enrollment request was already used")
	ErrEnrollmentSlow          = errors.New("device enrollment polling too quickly")
	ErrEnrollmentTicketExpired = errors.New("device enrollment installation ticket expired")
)

type DeviceEnrollment struct {
	ID                   string    `json:"id"`
	Name                 string    `json:"name"`
	Serial               string    `json:"serial"`
	Platform             string    `json:"platform"`
	Status               string    `json:"status"`
	CreatedAt            time.Time `json:"created_at"`
	ExpiresAt            time.Time `json:"expires_at"`
	Recovery             bool      `json:"recovery"`
	PublicKey            []byte    `json:"-"`
	UserCode             string    `json:"-"`
	DeviceCodeHash       []byte    `json:"-"`
	DeviceCodeCiphertext []byte    `json:"-"`
	OrganizationID       string    `json:"-"`
	ActorUserID          string    `json:"-"`
	OperationID          string    `json:"operation_id,omitempty"`
	VehicleID            string    `json:"vehicle_id,omitempty"`
	TicketHash           []byte    `json:"-"`
	TicketCiphertext     []byte    `json:"-"`
	TicketExpiresAt      time.Time `json:"-"`
}

const enrollmentSelect = `SELECT e.enrollment_id,e.name,e.serial,e.platform,e.status,e.created_at,e.expires_at,e.recovery,
	e.public_key,e.user_code,e.device_code_hash,e.device_code_ciphertext,COALESCE(e.org_id::text,''),COALESCE(e.actor_user_id::text,''),
	COALESCE(e.operation_id::text,''),COALESCE(o.vehicle_id,''),e.ticket_hash,e.ticket_ciphertext,COALESCE(e.ticket_expires_at,'epoch'::timestamptz)
	FROM authz_device_enrollments e LEFT JOIN authz_onboarding_operations o ON o.operation_id=e.operation_id`

func scanEnrollment(row interface{ Scan(...any) error }) (DeviceEnrollment, error) {
	var e DeviceEnrollment
	err := row.Scan(&e.ID, &e.Name, &e.Serial, &e.Platform, &e.Status, &e.CreatedAt, &e.ExpiresAt, &e.Recovery,
		&e.PublicKey, &e.UserCode, &e.DeviceCodeHash, &e.DeviceCodeCiphertext, &e.OrganizationID, &e.ActorUserID,
		&e.OperationID, &e.VehicleID, &e.TicketHash, &e.TicketCiphertext, &e.TicketExpiresAt)
	return e, err
}

func enrollmentEvent(ctx context.Context, tx *sql.Tx, e DeviceEnrollment, event string) error {
	var actor any
	if e.ActorUserID != "" {
		actor = e.ActorUserID
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO authz_device_enrollment_events(event_id,enrollment_id,actor_user_id,event_type) VALUES($1,$2,$3,$4)`,
		uuid.NewString(), e.ID, actor, event)
	return err
}

// Request authentication is performed before this write. Nonces are shared
// across actions so a signed request cannot be redeemed twice.
func (s *Store) UseEnrollmentNonce(ctx context.Context, key []byte, nonce string) error {
	if len(key) != 32 || !isCanonicalUUID(nonce) {
		return ErrEnrollmentInvalid
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM authz_device_enrollment_nonces WHERE created_at < now()-interval '5 minutes'`); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO authz_device_enrollment_nonces(public_key,nonce) VALUES($1,$2) ON CONFLICT DO NOTHING`, key, nonce)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrEnrollmentReplay
	}
	return tx.Commit()
}

func isCanonicalUUID(id string) bool {
	_, err := canonicalUUID(id)
	return err == nil
}

func (s *Store) CreateDeviceEnrollment(ctx context.Context, in DeviceEnrollment) (DeviceEnrollment, error) {
	if !isCanonicalUUID(in.ID) || len(in.PublicKey) != 32 || len(in.DeviceCodeHash) != 32 ||
		len(in.DeviceCodeCiphertext) < 28 || len(in.UserCode) != 8 || !validText(in.Name, 200) ||
		!validText(in.Serial, 128) || !validText(in.Platform, 128) {
		return DeviceEnrollment{}, ErrEnrollmentInvalid
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	defer tx.Rollback()
	prior, err := scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1`, in.ID))
	if err == nil {
		if !bytes.Equal(prior.PublicKey, in.PublicKey) || prior.Name != in.Name || prior.Serial != in.Serial || prior.Platform != in.Platform {
			return DeviceEnrollment{}, ErrEnrollmentInvalid
		}
		if prior.Status != "active" && !prior.ExpiresAt.After(time.Now()) {
			prior.Status = "expired"
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return DeviceEnrollment{}, err
	}
	// A new request ID intentionally refreshes the code, never the device key
	// or its previously approved vehicle identity.
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_enrollments SET status='expired',ticket_ciphertext=NULL
		WHERE public_key=$1 AND status IN ('pending','approved')`, in.PublicKey); err != nil {
		return DeviceEnrollment{}, err
	}
	var operationID, orgID string
	err = tx.QueryRowContext(ctx, `SELECT k.operation_id::text,COALESCE(v.org_id,o.org_id)::text
		FROM authz_enrolled_device_keys k
		JOIN authz_onboarding_operations o ON o.operation_id=k.operation_id
		LEFT JOIN authz_vehicles v ON v.vehicle_id=o.vehicle_id
		WHERE k.public_key=$1`, in.PublicKey).Scan(&operationID, &orgID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DeviceEnrollment{}, err
	}
	var org, operation any
	if operationID != "" {
		org, operation = orgID, operationID
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO authz_device_enrollments(enrollment_id,public_key,device_code_hash,device_code_ciphertext,user_code,name,serial,platform,expires_at,org_id,operation_id,recovery)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '15 minutes',$9,$10,$11)`,
		in.ID, in.PublicKey, in.DeviceCodeHash, in.DeviceCodeCiphertext, in.UserCode, in.Name, in.Serial, in.Platform, org, operation, operation != nil)
	if err != nil {
		return DeviceEnrollment{}, mutationError(err)
	}
	in, err = scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1`, in.ID))
	if err != nil {
		return DeviceEnrollment{}, err
	}
	if err := enrollmentEvent(ctx, tx, in, "requested"); err != nil {
		return DeviceEnrollment{}, err
	}
	return in, tx.Commit()
}

func (s *Store) LookupDeviceEnrollment(ctx context.Context, actor, org, userCode string) (DeviceEnrollment, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	if !allowed {
		return DeviceEnrollment{}, ErrNotOrganizationAdmin
	}
	e, err := scanEnrollment(s.db.QueryRowContext(ctx, enrollmentSelect+` WHERE e.user_code=$1 AND (e.org_id IS NULL OR e.org_id=$2)`, userCode, org))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrEnrollmentInvalid
	}
	if err == nil && e.Status != "active" && !e.ExpiresAt.After(time.Now()) {
		e.Status = "expired"
	}
	return e, err
}

func (s *Store) DeviceEnrollment(ctx context.Context, id string, key, codeHash []byte, poll bool) (DeviceEnrollment, error) {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	defer tx.Rollback()
	e, err := scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1 AND e.public_key=$2 AND e.device_code_hash=$3 FOR UPDATE OF e`, id, key, codeHash))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrEnrollmentInvalid
	}
	if err != nil {
		return e, err
	}
	if e.Status != "active" && !e.ExpiresAt.After(time.Now()) {
		e.Status = "expired"
	}
	if poll {
		res, err := tx.ExecContext(ctx, `UPDATE authz_device_enrollments SET next_poll_at=now()+interval '5 seconds' WHERE enrollment_id=$1 AND next_poll_at<=now()`, id)
		if err != nil {
			return e, err
		}
		if n, _ := res.RowsAffected(); n != 1 {
			return e, ErrEnrollmentSlow
		}
	}
	return e, tx.Commit()
}

func (s *Store) EnrollmentForApproval(ctx context.Context, actor, org, id string) (DeviceEnrollment, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	if !allowed {
		return DeviceEnrollment{}, ErrNotOrganizationAdmin
	}
	e, err := scanEnrollment(s.db.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1 AND (e.org_id IS NULL OR e.org_id=$2)`, id, org))
	if errors.Is(err, sql.ErrNoRows) {
		return e, ErrEnrollmentInvalid
	}
	if err == nil && (!e.ExpiresAt.After(time.Now()) || e.Status != "pending" && e.Status != "approved") {
		return e, ErrEnrollmentInvalid
	}
	return e, err
}

// Reserve the provider identity and bind the key/approval in one transaction.
// A crash or renewed device code cannot leave an unbound provisioning plan.
func (s *Store) CreateApprovedDeviceEnrollment(ctx context.Context, actor, org, id string, request OnboardingRequest, ciphertext []byte) (DeviceEnrollment, error) {
	r, err := normalizeOnboarding(request)
	if err != nil || r.Kind != "vehicle" || r.IdempotencyKey != id || len(ciphertext) < 28 {
		return DeviceEnrollment{}, ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	defer tx.Rollback()
	e, err := scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1 FOR UPDATE OF e`, id))
	if err != nil {
		return e, err
	}
	if e.Recovery || e.OrganizationID != "" && e.OrganizationID != org || !e.ExpiresAt.After(time.Now()) ||
		e.Status != "pending" && e.Status != "approved" {
		return e, ErrEnrollmentInvalid
	}
	op, err := createOnboardingInTx(ctx, tx, actor, org, r, ciphertext)
	if err != nil {
		return e, err
	}
	e, err = bindApprovedDeviceEnrollmentInTx(ctx, tx, e, op, actor, org)
	if err != nil {
		return e, err
	}
	return e, tx.Commit()
}

func (s *Store) ApproveDeviceEnrollment(ctx context.Context, actor, org, id, operationID string) (DeviceEnrollment, error) {
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	defer tx.Rollback()
	e, err := scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1 FOR UPDATE OF e`, id))
	if err != nil {
		return e, err
	}
	if e.OrganizationID != "" && e.OrganizationID != org || !e.ExpiresAt.After(time.Now()) ||
		(e.Status != "pending" && e.Status != "approved") {
		return e, ErrEnrollmentInvalid
	}
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1 AND org_id=$2`, operationID, org))
	if err != nil {
		return e, err
	}
	e, err = bindApprovedDeviceEnrollmentInTx(ctx, tx, e, op, actor, org)
	if err != nil {
		return e, err
	}
	return e, tx.Commit()
}

func bindApprovedDeviceEnrollmentInTx(ctx context.Context, tx *sql.Tx, e DeviceEnrollment, op OnboardingOperation, actor, org string) (DeviceEnrollment, error) {
	if e.OperationID != "" && e.OperationID != op.ID {
		return e, ErrConflict
	}
	if op.Kind != "vehicle" || op.ActorUserID != actor {
		return e, ErrConflict
	}
	if e.Status == "approved" {
		return e, nil
	}
	var binding string
	if err := tx.QueryRowContext(ctx, `INSERT INTO authz_enrolled_device_keys(public_key,operation_id) VALUES($1,$2)
		ON CONFLICT(public_key) DO UPDATE SET public_key=EXCLUDED.public_key RETURNING operation_id::text`,
		e.PublicKey, op.ID).Scan(&binding); err != nil {
		return e, mutationError(err)
	}
	if binding != op.ID {
		return e, ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_enrollments SET status='approved',org_id=$2,actor_user_id=$3,operation_id=$4,
		expires_at=now()+interval '24 hours' WHERE enrollment_id=$1`, e.ID, org, actor, op.ID); err != nil {
		return e, err
	}
	e.Status, e.OrganizationID, e.ActorUserID, e.OperationID, e.VehicleID = "approved", org, actor, op.ID, op.VehicleID
	e.ExpiresAt = time.Now().UTC().Add(24 * time.Hour)
	if err := enrollmentEvent(ctx, tx, e, "approved"); err != nil {
		return e, err
	}
	return e, nil
}

func (s *Store) DenyDeviceEnrollment(ctx context.Context, actor, org, id string) (DeviceEnrollment, error) {
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return DeviceEnrollment{}, err
	}
	defer tx.Rollback()
	e, err := scanEnrollment(tx.QueryRowContext(ctx, enrollmentSelect+` WHERE e.enrollment_id=$1 FOR UPDATE OF e`, id))
	if err != nil {
		return e, err
	}
	if e.OrganizationID != "" && e.OrganizationID != org || e.Status != "pending" || !e.ExpiresAt.After(time.Now()) {
		return e, ErrEnrollmentInvalid
	}
	e.Status, e.ActorUserID, e.OrganizationID = "denied", actor, org
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_enrollments SET status='denied',org_id=$2,actor_user_id=$3 WHERE enrollment_id=$1`, id, org, actor); err != nil {
		return e, err
	}
	if err := enrollmentEvent(ctx, tx, e, "denied"); err != nil {
		return e, err
	}
	return e, tx.Commit()
}

func (s *Store) IssueDeviceEnrollmentTicket(ctx context.Context, e DeviceEnrollment, hash []byte, ciphertext []byte, expiry time.Time) error {
	if len(hash) != sha256.Size || len(ciphertext) < 28 || !expiry.After(time.Now()) || expiry.After(time.Now().Add(10*time.Minute)) {
		return ErrEnrollmentInvalid
	}
	tx, _, err := s.managementTx(ctx, e.ActorUserID, e.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var eligible bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_device_enrollments e
		JOIN authz_onboarding_operations o ON o.operation_id=e.operation_id
		JOIN authz_vehicles v ON v.vehicle_id=o.vehicle_id AND v.org_id=e.org_id
		JOIN authz_vehicle_identities i ON i.vehicle_id=v.vehicle_id AND i.client_id=o.client_id
		WHERE e.enrollment_id=$1 AND e.status='approved' AND e.expires_at>now() AND o.status='awaiting_install'
		AND v.status='active' AND i.status='active')`, e.ID).Scan(&eligible); err != nil {
		return err
	}
	if !eligible {
		return ErrEnrollmentInvalid
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_installation_tickets SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL`, e.TicketHash); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_installation_tickets(token_hash,operation_id,expires_at,device_enrollment_id) VALUES($1,$2,$3,$4)`, hash, e.OperationID, expiry, e.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_enrollments SET ticket_hash=$2,ticket_ciphertext=$3,ticket_expires_at=$4 WHERE enrollment_id=$1`,
		e.ID, hash, ciphertext, expiry); err != nil {
		return err
	}
	if err := enrollmentEvent(ctx, tx, e, "ticket_issued"); err != nil {
		return err
	}
	return tx.Commit()
}

// Unlike the bearer-only manual installer, proof-authenticated retries can
// retrieve the same pending credential after a lost response. Each retry has
// a fresh nonce, and no retrieval is allowed after machine-auth confirmation.
func (s *Store) RedeemDeviceEnrollment(ctx context.Context, e DeviceEnrollment, ticketHash []byte) (OnboardingOperation, error) {
	tx, _, err := s.managementTx(ctx, e.ActorUserID, e.OrganizationID)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	if e.Status != "approved" || !e.ExpiresAt.After(time.Now()) || !bytes.Equal(e.TicketHash, ticketHash) {
		return OnboardingOperation{}, ErrInstallationTicket
	}
	if !e.TicketExpiresAt.After(time.Now()) {
		return OnboardingOperation{}, ErrEnrollmentTicketExpired
	}
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1 AND status='awaiting_install'`, e.OperationID))
	if err != nil {
		return op, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE authz_installation_tickets t SET consumed_at=COALESCE(consumed_at,now())
		FROM authz_vehicles v,authz_vehicle_identities i
		WHERE t.token_hash=$1 AND t.operation_id=$2 AND t.revoked_at IS NULL AND t.expires_at>now() AND t.device_enrollment_id=$6
		AND v.vehicle_id=$3 AND v.org_id=$4 AND v.status='active' AND i.vehicle_id=v.vehicle_id AND i.status='active' AND i.client_id=$5`,
		ticketHash, op.ID, op.VehicleID, e.OrganizationID, op.ClientID, e.ID)
	if err != nil {
		return op, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return op, err
	}
	if n != 1 {
		if !e.TicketExpiresAt.After(time.Now()) {
			return op, ErrEnrollmentTicketExpired
		}
		return op, ErrInstallationTicket
	}
	if err := enrollmentEvent(ctx, tx, e, "credential_delivered"); err != nil {
		return op, err
	}
	return op, tx.Commit()
}

// Recovery is only called inside the existing maintenance/drain guard.
// Its operation/client/vehicle IDs never change.
func (s *Store) PrepareDeviceEnrollmentRecovery(ctx context.Context, actor, org, operationID string, ciphertext []byte) (OnboardingOperation, error) {
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	op, err := scanOnboarding(tx.QueryRowContext(ctx, onboardingSelect+` WHERE operation_id=$1 AND org_id=$2 FOR UPDATE`, operationID, org))
	if err != nil {
		return op, err
	}
	if op.Kind != "vehicle" || (op.Status != "completed" && op.Status != "awaiting_install") || len(ciphertext) < 28 {
		return op, ErrConflict
	}
	active, err := activeVehicle(ctx, tx, org, op.VehicleID)
	if err != nil {
		return op, err
	}
	if !active {
		return op, ErrInactiveLifecycle
	}
	var identityActive bool
	if err := tx.QueryRowContext(ctx, `SELECT status='active' FROM authz_vehicle_identities WHERE vehicle_id=$1 AND client_id=$2`, op.VehicleID, op.ClientID).Scan(&identityActive); err != nil {
		return op, err
	}
	if !identityActive {
		return op, ErrInactiveLifecycle
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_installation_tickets SET revoked_at=now() WHERE operation_id=$1 AND revoked_at IS NULL`, op.ID); err != nil {
		return op, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET actor_user_id=$2,status='awaiting_install',stage='installation',
		credential_ciphertext=$3,error_code='PROVIDER_UNAVAILABLE',updated_at=now() WHERE operation_id=$1`, op.ID, actor, ciphertext); err != nil {
		return op, err
	}
	op.ActorUserID, op.Status, op.Stage, op.CredentialCiphertext = actor, "awaiting_install", "installation", ciphertext
	if err := onboardingEvent(ctx, tx, op.ID, "device_recovery_requested", ""); err != nil {
		return op, err
	}
	return op, tx.Commit()
}

func (s *Store) ClearDeviceEnrollmentRecoveryError(ctx context.Context, actor, org, operationID string) error {
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET error_code='' WHERE operation_id=$1 AND org_id=$2 AND actor_user_id=$3 AND status='awaiting_install'`,
		operationID, org, actor); err != nil {
		return err
	}
	return tx.Commit()
}
