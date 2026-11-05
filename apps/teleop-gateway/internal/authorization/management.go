package authorization

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	ErrConflict                  = errors.New("resource already exists or concurrent mutation; refresh and retry")
	ErrIdentityBindingRestricted = errors.New("only a platform operator may bind a manually provisioned identity")
	ErrUnknownIdentity           = errors.New("identity is not actively bound")
	ErrInvalidRegistration       = errors.New("invalid registration")
	ErrBootstrapGatewayRunning   = errors.New("bootstrap requires the managed Gateway to be stopped")
)

type Organization struct {
	OrganizationID string `json:"org_id"`
	Name           string `json:"name"`
}

type Person struct {
	UserID     string   `json:"user_id"`
	Name       string   `json:"name"`
	Subject    string   `json:"subject"`
	Status     string   `json:"status"`
	Role       Role     `json:"role"`
	Scope      Scope    `json:"scope"`
	VehicleIDs []string `json:"vehicle_ids"`
}

type Vehicle struct {
	VehicleID      string `json:"vehicle_id"`
	OrganizationID string `json:"-"`
	Name           string `json:"name"`
	Status         string `json:"status"`
	Subject        string `json:"subject"`
	ClientID       string `json:"-"`
}

type ManagementContext struct {
	AuthorizationVersion int64          `json:"authorization_version"`
	Mode                 string         `json:"mode"`
	Organizations        []Organization `json:"organizations"`
	PlatformAdmin        bool           `json:"platform_admin"`
	ManualProvisioning   bool           `json:"manual_provisioning"`
	CanBindIdentities    bool           `json:"can_bind_identities"`
	IdentityProvisioning string         `json:"identity_provisioning"`
}

func (s *Store) ResolveUser(ctx context.Context, issuer, subject string) (string, error) {
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT u.user_id FROM authz_external_identity_bindings b
		JOIN authz_users u ON u.user_id=b.user_id
		WHERE b.issuer=$1 AND b.subject=$2 AND b.status='active' AND u.status='active'`, issuer, subject).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrUnknownIdentity
	}
	return id, err
}

func (s *Store) ResolveVehicle(ctx context.Context, issuer, subject string) (Vehicle, error) {
	var v Vehicle
	err := s.db.QueryRowContext(ctx, `SELECT v.vehicle_id,v.org_id,v.name,v.status,i.subject,COALESCE(i.client_id,'')
		FROM authz_vehicle_identities i JOIN authz_vehicles v ON v.vehicle_id=i.vehicle_id
		JOIN authz_organizations o ON o.org_id=v.org_id
		WHERE i.issuer=$1 AND i.subject=$2 AND i.status='active' AND v.status='active' AND o.status='active'`,
		issuer, subject).Scan(&v.VehicleID, &v.OrganizationID, &v.Name, &v.Status, &v.Subject, &v.ClientID)
	if errors.Is(err, sql.ErrNoRows) {
		return Vehicle{}, ErrUnknownIdentity
	}
	return v, err
}

func (s *Store) UserOrganizations(ctx context.Context, userID string) ([]Organization, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT o.org_id,o.name FROM authz_organizations o
		JOIN authz_organization_memberships m ON m.org_id=o.org_id
		JOIN authz_users u ON u.user_id=m.user_id
		WHERE u.user_id=$1 AND u.status='active' AND m.status='active' AND o.status='active' ORDER BY o.org_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Organization, 0)
	for rows.Next() {
		var o Organization
		if err := rows.Scan(&o.OrganizationID, &o.Name); err != nil {
			return nil, err
		}
		result = append(result, o)
	}
	return result, rows.Err()
}

func (s *Store) ActiveOrganizationVehicles(ctx context.Context, orgID string) ([]Vehicle, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT v.vehicle_id,v.org_id,v.name,v.status,COALESCE(i.subject,'')
		FROM authz_vehicles v JOIN authz_organizations o ON o.org_id=v.org_id
		LEFT JOIN authz_vehicle_identities i ON i.vehicle_id=v.vehicle_id AND i.status='active'
		WHERE v.org_id=$1 AND v.status='active' AND o.status='active' ORDER BY v.vehicle_id`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVehicles(rows)
}

func (s *Store) UserAssignment(ctx context.Context, userID, orgID string) (Person, error) {
	people, err := s.people(ctx, orgID, "", userID)
	if err != nil {
		return Person{}, err
	}
	if len(people) != 1 {
		return Person{}, ErrInactiveLifecycle
	}
	return people[0], nil
}

func (s *Store) ManagedContext(ctx context.Context, userID string) (ManagementContext, error) {
	result := ManagementContext{Mode: "managed", Organizations: []Organization{}, ManualProvisioning: true,
		IdentityProvisioning: "Manual Casdoor provisioning; only platform operators may create trusted subject bindings. Organization administrators may add already-bound people; identity rebinding is not supported."}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1 AND status='active'`, userID).Scan(&result.PlatformAdmin); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return result, ErrNotOrganizationAdmin
		}
		return result, err
	}
	version, err := readVersion(ctx, tx, false)
	if err != nil {
		return result, err
	}
	result.AuthorizationVersion = version
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err != nil {
		return result, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT o.org_id,o.name,EXISTS(SELECT 1 FROM authz_organization_memberships m
		WHERE m.org_id=o.org_id AND m.user_id=$1 AND m.status='active')
		FROM authz_organizations o WHERE o.status='active' ORDER BY o.org_id`, userID)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var o Organization
		var member bool
		if err := rows.Scan(&o.OrganizationID, &o.Name, &member); err != nil {
			rows.Close()
			return result, err
		}
		if result.PlatformAdmin || (member && snapshot.canManageOrganization(userID, o.OrganizationID)) {
			result.Organizations = append(result.Organizations, o)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if !result.PlatformAdmin && len(result.Organizations) == 0 {
		return result, ErrNotOrganizationAdmin
	}
	result.CanBindIdentities = result.PlatformAdmin
	return result, tx.Commit()
}

func (s *Store) CanManageOrganization(ctx context.Context, userID, orgID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	version, err := readVersion(ctx, tx, false)
	if err != nil {
		return false, err
	}
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err != nil {
		return false, err
	}
	if err := requireManager(ctx, tx, snapshot, userID, orgID); err != nil {
		if errors.Is(err, ErrNotOrganizationAdmin) || errors.Is(err, ErrInactiveLifecycle) {
			return false, nil
		}
		return false, err
	}
	return true, tx.Commit()
}

func requireManager(ctx context.Context, tx *sql.Tx, snapshot *engineSnapshot, userID, orgID string) error {
	var platform, activeOrg bool
	err := tx.QueryRowContext(ctx, `SELECT platform_admin,EXISTS(SELECT 1 FROM authz_organizations WHERE org_id=$2 AND status='active')
		FROM authz_users WHERE user_id=$1 AND status='active'`, userID, orgID).Scan(&platform, &activeOrg)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotOrganizationAdmin
	}
	if err != nil {
		return err
	}
	if !activeOrg {
		return ErrInactiveLifecycle
	}
	if platform {
		return nil
	}
	active, err := activeMember(ctx, tx, orgID, userID)
	if err != nil {
		return err
	}
	if !active || !snapshot.canManageOrganization(userID, orgID) {
		return ErrNotOrganizationAdmin
	}
	return nil
}

func (s *Store) ListPeople(ctx context.Context, actor, orgID, issuer string) ([]Person, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, orgID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrNotOrganizationAdmin
	}
	return s.people(ctx, orgID, issuer, "")
}

func (s *Store) people(ctx context.Context, orgID, issuer, userID string) ([]Person, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT u.user_id,u.name,COALESCE(b.subject,''),m.status,COALESCE(p.v2,''),COALESCE(p.v4,''),COALESCE(p.v5,'')
		FROM authz_organization_memberships m JOIN authz_users u ON u.user_id=m.user_id
		LEFT JOIN authz_external_identity_bindings b ON b.user_id=u.user_id AND b.status='active' AND ($2='' OR b.issuer=$2)
		LEFT JOIN casbin_rule g ON g.ptype='g' AND g.v0='user:'||u.user_id::text AND g.v2='org:'||m.org_id::text
		LEFT JOIN casbin_rule p ON p.ptype='p' AND p.v0=g.v2 AND p.v1=g.v1 AND p.v3='vehicle.read'
		WHERE m.org_id=$1 AND ($3='' OR u.user_id::text=$3) ORDER BY u.user_id,p.v5`, orgID, issuer, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]Person, 0)
	for rows.Next() {
		var p Person
		var role, vehicle string
		if err := rows.Scan(&p.UserID, &p.Name, &p.Subject, &p.Status, &role, &p.Scope, &vehicle); err != nil {
			return nil, err
		}
		p.Role = Role(strings.TrimPrefix(role, "role:"))
		p.VehicleIDs = []string{}
		if p.Scope == ScopeSelected {
			p.VehicleIDs = append(p.VehicleIDs, vehicle)
		}
		if len(result) > 0 && result[len(result)-1].UserID == p.UserID {
			prior := &result[len(result)-1]
			if p.Scope == ScopeSelected && (len(prior.VehicleIDs) == 0 || prior.VehicleIDs[len(prior.VehicleIDs)-1] != vehicle) {
				prior.VehicleIDs = append(prior.VehicleIDs, vehicle)
			}
		} else {
			result = append(result, p)
		}
	}
	return result, rows.Err()
}

func (s *Store) ListVehicles(ctx context.Context, actor, orgID, issuer string) ([]Vehicle, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, orgID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrNotOrganizationAdmin
	}
	rows, err := s.db.QueryContext(ctx, `SELECT v.vehicle_id,v.org_id,v.name,v.status,COALESCE(i.subject,'')
		FROM authz_vehicles v LEFT JOIN authz_vehicle_identities i ON i.vehicle_id=v.vehicle_id AND i.issuer=$2
		WHERE v.org_id=$1 ORDER BY v.vehicle_id`, orgID, issuer)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanVehicles(rows)
}

func scanVehicles(rows *sql.Rows) ([]Vehicle, error) {
	result := make([]Vehicle, 0)
	for rows.Next() {
		var v Vehicle
		if err := rows.Scan(&v.VehicleID, &v.OrganizationID, &v.Name, &v.Status, &v.Subject); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}

func (s *Store) managementTx(ctx context.Context, actor, orgID string) (*sql.Tx, int64, error) {
	if _, err := canonicalUUID(actor); err != nil {
		return nil, 0, ErrInvalidRegistration
	}
	if _, err := canonicalUUID(orgID); err != nil {
		return nil, 0, ErrInvalidRegistration
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return nil, 0, err
	}
	version, err := readVersion(ctx, tx, true)
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err == nil {
		err = requireManager(ctx, tx, snapshot, actor, orgID)
	}
	if err != nil {
		tx.Rollback()
		return nil, 0, err
	}
	return tx, version, nil
}

func (s *Store) RegisterPerson(ctx context.Context, actor, orgID, issuer, name, subject string) (Person, error) {
	return s.registerPerson(ctx, actor, orgID, issuer, name, subject, false)
}

func (s *Store) AddExistingMember(ctx context.Context, actor, orgID, issuer, subject string) (Person, error) {
	return s.registerPerson(ctx, actor, orgID, issuer, "Existing member", subject, true)
}

func (s *Store) registerPerson(ctx context.Context, actor, orgID, issuer, name, subject string, existingOnly bool) (Person, error) {
	if !validText(name, 200) || !validText(issuer, 2048) || !validText(subject, 512) {
		return Person{}, ErrInvalidRegistration
	}
	tx, version, err := s.managementTx(ctx, actor, orgID)
	if err != nil {
		return Person{}, err
	}
	defer tx.Rollback()
	var platform bool
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1`, actor).Scan(&platform); err != nil {
		return Person{}, err
	}
	p := Person{Name: name, Subject: subject, Status: "active", VehicleIDs: []string{}}
	err = tx.QueryRowContext(ctx, `SELECT u.user_id,u.name FROM authz_external_identity_bindings b JOIN authz_users u ON u.user_id=b.user_id
		WHERE b.issuer=$1 AND b.subject=$2 AND b.status='active' AND u.status='active'`, issuer, subject).Scan(&p.UserID, &p.Name)
	if errors.Is(err, sql.ErrNoRows) {
		if !platform || existingOnly {
			return Person{}, ErrIdentityBindingRestricted
		}
		p.UserID = uuid.NewString()
		if _, err = tx.ExecContext(ctx, `INSERT INTO authz_users(user_id,status,name) VALUES($1,'active',$2)`, p.UserID, name); err != nil {
			return Person{}, mutationError(err)
		}
		if err = insertUserBinding(ctx, tx, issuer, subject, p.UserID); err != nil {
			return Person{}, mutationError(err)
		}
	} else if err != nil {
		return Person{}, err
	}
	if p.UserID == actor {
		return Person{}, ErrSelfAssignment
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO authz_organization_memberships(org_id,user_id,status) VALUES($1,$2,'active')`, orgID, p.UserID); err != nil {
		return Person{}, mutationError(err)
	}
	if err = commitManagement(ctx, tx, version, actor, orgID, p.UserID, "person_registered", map[string]string{"user_id": p.UserID}); err != nil {
		return Person{}, err
	}
	return p, nil
}

func insertUserBinding(ctx context.Context, tx *sql.Tx, issuer, subject, userID string) error {
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_identity_subjects(issuer,subject,identity_kind) VALUES($1,$2,'user')`, issuer, subject); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO authz_external_identity_bindings(issuer,subject,user_id,status) VALUES($1,$2,$3,'active')`, issuer, subject, userID)
	return err
}

func (s *Store) RegisterVehicle(ctx context.Context, actor, orgID, issuer, vehicleID, name, subject string) (Vehicle, error) {
	if !validVehicleID(vehicleID) || vehicleID == "*" || !validText(name, 200) || !validText(issuer, 2048) || !validText(subject, 512) {
		return Vehicle{}, ErrInvalidRegistration
	}
	tx, version, err := s.managementTx(ctx, actor, orgID)
	if err != nil {
		return Vehicle{}, err
	}
	defer tx.Rollback()
	var platform bool
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1`, actor).Scan(&platform); err != nil {
		return Vehicle{}, err
	}
	if !platform {
		return Vehicle{}, ErrIdentityBindingRestricted
	}
	v := Vehicle{VehicleID: vehicleID, OrganizationID: orgID, Name: name, Status: "active", Subject: subject}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_vehicles(vehicle_id,org_id,status,name) VALUES($1,$2,'active',$3)`, vehicleID, orgID, name); err != nil {
		return Vehicle{}, mutationError(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_identity_subjects(issuer,subject,identity_kind) VALUES($1,$2,'vehicle')`, issuer, subject); err != nil {
		return Vehicle{}, mutationError(err)
	}
	// No client_id or credential is inferred from the subject. The verified token
	// subject is the pilot binding; client lifecycle remains manually provisioned.
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_vehicle_identities(vehicle_id,issuer,subject,binding_version,status,provisioning_mode)
		VALUES($1,$2,$3,1,'active','manual')`,
		vehicleID, issuer, subject); err != nil {
		return Vehicle{}, mutationError(err)
	}
	if err := commitManagement(ctx, tx, version, actor, orgID, "", "vehicle_registered", map[string]string{"vehicle_id": vehicleID}); err != nil {
		return Vehicle{}, err
	}
	return v, nil
}

func commitManagement(ctx context.Context, tx *sql.Tx, version int64, actor, orgID, subject, eventType string, details any) error {
	payload, err := json.Marshal(details)
	if err != nil {
		return err
	}
	version++
	if _, err := tx.ExecContext(ctx, `UPDATE authz_authorization_state SET version=$1 WHERE state_key=1`, version); err != nil {
		return err
	}
	eventID := uuid.NewString()
	var subjectID any
	if subject != "" {
		subjectID = subject
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_audit_events(event_id,org_id,actor_user_id,subject_user_id,event_type,authorization_version,details)
		VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, eventID, orgID, actor, subjectID, eventType, version, string(payload)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_outbox(event_id,org_id,authorization_version,event_type,payload)
		VALUES($1,$2,$3,'authorization.changed',$4::jsonb)`, eventID, orgID, version, string(payload)); err != nil {
		return err
	}
	return mutationError(tx.Commit())
}

func mutationError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && (pg.Code == "23505" || pg.Code == "40001") {
		return ErrConflict
	}
	return err
}

func validText(value string, max int) bool {
	if value == "" || value != strings.TrimSpace(value) || len(value) > max {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func (s *Store) RecordTokenExpiry(ctx context.Context, orgID string, expiry time.Time) error {
	_, err := s.db.ExecContext(ctx, recordTokenExpirySQL, orgID, expiry.UTC())
	return err
}

const recordTokenExpirySQL = `INSERT INTO authz_token_horizons(org_id,expires_at) VALUES($1,$2)
	ON CONFLICT(org_id) DO UPDATE SET expires_at=GREATEST(authz_token_horizons.expires_at,EXCLUDED.expires_at)`

// RecordTokenExpiryOn binds token reservation to the connection owning the
// runtime lifetime lock; a lost session cannot issue through a pooled fallback.
func (s *Store) RecordTokenExpiryOn(ctx context.Context, conn *sql.Conn, orgID string, expiry time.Time) error {
	if conn == nil {
		return errors.New("token reservation requires the runtime lock connection")
	}
	_, err := conn.ExecContext(ctx, recordTokenExpirySQL, orgID, expiry.UTC())
	return err
}

// An empty organization requests the global horizon for the conservative
// single-Gateway mutation drain. This state deliberately survives restarts.
func (s *Store) TokenExpiry(ctx context.Context, orgID string) (time.Time, error) {
	var expiry sql.NullTime
	err := s.db.QueryRowContext(ctx, `SELECT max(expires_at) FROM authz_token_horizons WHERE ($1='' OR org_id::text=$1)`, orgID).Scan(&expiry)
	if err != nil {
		return time.Time{}, err
	}
	return expiry.Time, nil
}

func (s *Store) DrainQuietUntil(ctx context.Context) (time.Time, error) {
	var until time.Time
	err := s.db.QueryRowContext(ctx, `SELECT quiet_until FROM authz_runtime_drain WHERE state_key=1`).Scan(&until)
	if errors.Is(err, sql.ErrNoRows) {
		return time.Time{}, nil
	}
	return until, err
}

func (s *Store) SetDrainQuietUntil(ctx context.Context, until time.Time) error {
	if until.IsZero() {
		_, err := s.db.ExecContext(ctx, `DELETE FROM authz_runtime_drain WHERE state_key=1`)
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO authz_runtime_drain(state_key,quiet_until) VALUES(1,$1)
		ON CONFLICT(state_key) DO UPDATE SET quiet_until=EXCLUDED.quiet_until`, until.UTC())
	return err
}

type BootstrapInput struct {
	OrganizationID   string `json:"org_id"`
	OrganizationName string `json:"org_name"`
	UserID           string `json:"user_id"`
	Name             string `json:"name"`
	Issuer           string `json:"issuer"`
	Subject          string `json:"subject"`
}

// Bootstrap only creates a new organization and new principal. Repeating the
// exact input is a no-op; it never restores privileges or rebinds an identity.
func (s *Store) Bootstrap(ctx context.Context, in BootstrapInput) error {
	var err error
	in.OrganizationID, err = canonicalUUID(in.OrganizationID)
	if err != nil {
		return ErrInvalidRegistration
	}
	in.UserID, err = canonicalUUID(in.UserID)
	if err != nil {
		return ErrInvalidRegistration
	}
	if !validText(in.OrganizationName, 200) || !validText(in.Name, 200) || !validText(in.Issuer, 2048) || !validText(in.Subject, 512) {
		return ErrInvalidRegistration
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Match the runtime's lifetime session lock. Hold this transaction lock
	// through commit so a Gateway cannot start between the check and mutation.
	var exclusive bool
	if err := tx.QueryRowContext(ctx, `SELECT pg_try_advisory_xact_lock(7439102342056781)`).Scan(&exclusive); err != nil {
		return fmt.Errorf("verify offline bootstrap exclusivity: %w", err)
	}
	if !exclusive {
		return ErrBootstrapGatewayRunning
	}
	version, err := readVersion(ctx, tx, true)
	if err != nil {
		return err
	}
	var same bool
	err = tx.QueryRowContext(ctx, `SELECT o.name=$2 AND u.name=$4 AND u.platform_admin AND o.status='active' AND u.status='active'
		AND b.issuer=$5 AND b.subject=$6 AND b.status='active' AND m.status='active'
		FROM authz_organizations o JOIN authz_users u ON u.user_id=$3
		JOIN authz_external_identity_bindings b ON b.user_id=u.user_id AND b.issuer=$5
		JOIN authz_organization_memberships m ON m.org_id=o.org_id AND m.user_id=u.user_id
		WHERE o.org_id=$1`, in.OrganizationID, in.OrganizationName, in.UserID, in.Name, in.Issuer, in.Subject).Scan(&same)
	if err == nil {
		if !same {
			return ErrConflict
		}
		snapshot, err := s.snapshotFor(ctx, tx, version)
		if err != nil {
			return err
		}
		if !snapshot.canManageOrganization(in.UserID, in.OrganizationID) {
			return ErrConflict
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_organizations(org_id,status,name) VALUES($1,'active',$2)`, in.OrganizationID, in.OrganizationName); err != nil {
		return mutationError(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_users(user_id,status,name,platform_admin) VALUES($1,'active',$2,true)`, in.UserID, in.Name); err != nil {
		return mutationError(err)
	}
	if err := insertUserBinding(ctx, tx, in.Issuer, in.Subject, in.UserID); err != nil {
		return mutationError(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_organization_memberships(org_id,user_id,status) VALUES($1,$2,'active')`, in.OrganizationID, in.UserID); err != nil {
		return err
	}
	assignment := Assignment{ActorUserID: in.UserID, UserID: in.UserID, OrganizationID: in.OrganizationID, Role: RoleOrgAdmin, Scope: ScopeAll}
	if err := replaceUserAssignment(ctx, tx, assignment, assignmentRules(assignment, "grant:"+uuid.NewString())); err != nil {
		return err
	}
	return commitManagement(ctx, tx, version, in.UserID, in.OrganizationID, in.UserID, "platform_bootstrapped", map[string]string{"mode": "manual-provisioning"})
}

func (s *Store) AssignManagedRole(ctx context.Context, a Assignment) (int64, error) {
	if a.Role != RoleOrgAdmin && a.Role != RoleViewer && a.Role != RoleRemoteOperator {
		return 0, ErrInvalidAssignment
	}
	if a.Role == RoleOrgAdmin && a.Scope != ScopeAll {
		return 0, fmt.Errorf("%w: organization administrators require all scope", ErrInvalidAssignment)
	}
	version, err := s.AssignRole(ctx, a)
	return version, mutationError(err)
}
