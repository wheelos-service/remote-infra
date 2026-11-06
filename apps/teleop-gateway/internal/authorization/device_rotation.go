package authorization

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"time"
)

type DeviceRotation struct {
	Operation      OnboardingOperation
	BindingVersion int64
	Status         string
	Attempts       int
}

const rotationSelect = `SELECT l.operation_id,l.org_id,l.actor_user_id,l.target_id,v.name,r.provider_name,r.client_id,r.credential_ciphertext,l.binding_version,r.status,r.attempts
FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicles v ON v.vehicle_id=l.target_id`

func scanRotation(row *sql.Row) (DeviceRotation, error) {
	var r DeviceRotation
	r.Operation.Kind = "vehicle"
	err := row.Scan(&r.Operation.ID, &r.Operation.OrganizationID, &r.Operation.ActorUserID, &r.Operation.VehicleID, &r.Operation.Name, &r.Operation.ProviderName, &r.Operation.ClientID, &r.Operation.CredentialCiphertext, &r.BindingVersion, &r.Status, &r.Attempts)
	return r, err
}
func (s *Store) NextRotation(ctx context.Context) (DeviceRotation, error) {
	return scanRotation(s.db.QueryRowContext(ctx, rotationSelect+` WHERE r.status='pending' AND l.provider_status='confirmed' AND r.next_attempt_at<=now() ORDER BY l.created_at LIMIT 1`))
}
func (s *Store) Rotation(ctx context.Context, actor, org, id string) (DeviceRotation, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return DeviceRotation{}, err
	}
	if !allowed {
		return DeviceRotation{}, ErrNotOrganizationAdmin
	}
	result, err := scanRotation(s.db.QueryRowContext(ctx, rotationSelect+` WHERE l.operation_id=$1 AND l.org_id=$2`, id, org))
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrConflict
	}
	return result, err
}
func (s *Store) FailRotation(ctx context.Context, r DeviceRotation, code string) error {
	if !validOnboardingError(code) {
		return ErrInvalidRegistration
	}
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,error_code=$2,next_attempt_at=now()+interval '30 seconds' WHERE operation_id=$1 AND status='pending'`, r.Operation.ID, code)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return ErrConflict
	}
	version, err := readVersion(ctx, tx, true)
	if err != nil {
		return err
	}
	return commitManagement(ctx, tx, version, r.Operation.ActorUserID, r.Operation.OrganizationID, "", "rotation_attempt_failed", map[string]string{"target_id": r.Operation.VehicleID, "operation_id": r.Operation.ID, "error_code": code, "outcome": "failed"})
}
func (s *Store) BindRotation(ctx context.Context, r DeviceRotation, issuer string) error {
	op := r.Operation
	tx, version, err := s.managementTx(ctx, op.ActorUserID, op.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var eligible bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicle_identities i ON i.vehicle_id=l.target_id JOIN authz_vehicles v USING(vehicle_id)
WHERE r.operation_id=$1 AND r.status='pending' AND l.provider_status='confirmed' AND v.org_id=l.org_id AND v.status='disabled' AND i.binding_version=$2 AND i.status IN ('revoked','pending'))`, op.ID, r.BindingVersion).Scan(&eligible)
	if err != nil {
		return err
	}
	if !eligible {
		return ErrConflict
	}
	subject := "admin/" + op.ProviderName
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_identity_subjects(issuer,subject,identity_kind) VALUES($1,$2,'vehicle') ON CONFLICT DO NOTHING`, issuer, subject); err != nil {
		return mutationError(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicle_identities SET subject=$2,client_id=$3,status='pending',secret_reference=$4,updated_at=now() WHERE vehicle_id=$1 AND binding_version=$5`, op.VehicleID, subject, op.ClientID, "rotation:"+op.ID, r.BindingVersion); err != nil {
		return mutationError(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status='awaiting_install',error_code='' WHERE operation_id=$1`, op.ID); err != nil {
		return err
	}
	return commitManagement(ctx, tx, version, op.ActorUserID, op.OrganizationID, "", "rotation_ready", map[string]string{"target_id": op.VehicleID, "operation_id": op.ID, "outcome": "applied"})
}
func (s *Store) ResolveInstallingVehicle(ctx context.Context, issuer, subject string) (Vehicle, error) {
	var v Vehicle
	err := s.db.QueryRowContext(ctx, `SELECT v.vehicle_id,v.org_id,v.name,v.status,i.subject,i.client_id FROM authz_vehicle_identities i JOIN authz_vehicles v USING(vehicle_id) JOIN authz_organizations o ON o.org_id=v.org_id
JOIN authz_lifecycle_operations l ON l.target_id=v.vehicle_id AND l.binding_version=i.binding_version JOIN authz_device_rotations r ON r.operation_id=l.operation_id AND r.client_id=i.client_id
WHERE i.issuer=$1 AND i.subject=$2 AND i.status='pending' AND v.status='disabled' AND o.status='active' AND r.status='awaiting_install' AND l.org_id=v.org_id`, issuer, subject).Scan(&v.VehicleID, &v.OrganizationID, &v.Name, &v.Status, &v.Subject, &v.ClientID)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrUnknownIdentity
	}
	return v, err
}
func (s *Store) PrepareRotationTicket(ctx context.Context, actor, org, id string, ciphertext []byte) (DeviceRotation, error) {
	if len(ciphertext) < 28 || len(ciphertext) > 4096 {
		return DeviceRotation{}, ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return DeviceRotation{}, err
	}
	defer tx.Rollback()
	r, err := scanRotation(tx.QueryRowContext(ctx, rotationSelect+` WHERE l.operation_id=$1 AND l.org_id=$2 AND r.status='awaiting_install' AND NOT EXISTS(SELECT 1 FROM authz_rotation_tickets t WHERE t.operation_id=r.operation_id AND t.consumed_at IS NOT NULL) FOR UPDATE`, id, org))
	if err != nil {
		return r, ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_rotation_tickets SET revoked_at=now() WHERE operation_id=$1 AND revoked_at IS NULL`, id); err != nil {
		return r, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET credential_ciphertext=$2,status='pending',attempts=0,error_code='' WHERE operation_id=$1`, id, ciphertext); err != nil {
		return r, err
	}
	r.Operation.CredentialCiphertext = ciphertext
	return r, tx.Commit()
}
func (s *Store) CreateRotationTicket(ctx context.Context, actor, org, id string, hash [sha256.Size]byte, expires time.Time) error {
	if !expires.After(time.Now()) || expires.After(time.Now().Add(5*time.Minute+time.Second)) {
		return ErrInvalidRegistration
	}
	tx, _, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var eligible bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicle_identities i ON i.vehicle_id=l.target_id WHERE l.operation_id=$1 AND l.org_id=$2 AND r.status='awaiting_install' AND i.status='pending' AND i.binding_version=l.binding_version AND i.client_id=r.client_id)`, id, org).Scan(&eligible); err != nil {
		return err
	}
	if !eligible {
		return ErrConflict
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO authz_rotation_tickets(token_hash,operation_id,expires_at) VALUES($1,$2,$3)`, hash[:], id, expires); err != nil {
		return err
	}
	return mutationError(tx.Commit())
}
func (s *Store) RotationTicketOrganization(ctx context.Context, hash [sha256.Size]byte) (string, error) {
	var org string
	err := s.db.QueryRowContext(ctx, `SELECT l.org_id FROM authz_rotation_tickets t JOIN authz_lifecycle_operations l USING(operation_id) WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now()`, hash[:]).Scan(&org)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrInstallationTicket
	}
	return org, err
}
func (s *Store) ConsumeRotationTicket(ctx context.Context, hash [sha256.Size]byte) (OnboardingOperation, error) {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return OnboardingOperation{}, err
	}
	defer tx.Rollback()
	var id string
	err = tx.QueryRowContext(ctx, `UPDATE authz_rotation_tickets t SET consumed_at=now() FROM authz_device_rotations r,authz_lifecycle_operations l,authz_vehicle_identities i,authz_vehicles v,authz_organizations o
WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>now() AND r.operation_id=t.operation_id AND r.status='awaiting_install'
AND l.operation_id=r.operation_id AND i.vehicle_id=l.target_id AND i.client_id=r.client_id AND i.binding_version=l.binding_version AND i.status='pending'
AND v.vehicle_id=i.vehicle_id AND v.status='disabled' AND v.org_id=l.org_id AND o.org_id=v.org_id AND o.status='active' RETURNING t.operation_id`, hash[:]).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return OnboardingOperation{}, ErrInstallationTicket
	}
	if err != nil {
		return OnboardingOperation{}, err
	}
	r, err := scanRotation(tx.QueryRowContext(ctx, rotationSelect+` WHERE l.operation_id=$1`, id))
	if err != nil {
		return r.Operation, err
	}
	return r.Operation, tx.Commit()
}
func (s *Store) CompleteRotation(ctx context.Context, issuer, vehicle, subject, client string) error {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	version, err := readVersion(ctx, tx, true)
	if err != nil {
		return err
	}
	var id, actor, org, status string
	err = tx.QueryRowContext(ctx, `SELECT r.operation_id,l.actor_user_id,l.org_id,r.status FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicle_identities i ON i.vehicle_id=l.target_id JOIN authz_vehicles v USING(vehicle_id) JOIN authz_organizations o ON o.org_id=v.org_id
WHERE i.vehicle_id=$1 AND i.issuer=$2 AND i.subject=$3 AND i.client_id=$4 AND i.client_id=r.client_id AND i.binding_version=l.binding_version AND r.status IN ('awaiting_install','completed') AND i.status IN ('pending','active') AND v.org_id=l.org_id AND o.status='active'
AND EXISTS(SELECT 1 FROM authz_rotation_tickets t WHERE t.operation_id=r.operation_id AND t.consumed_at IS NOT NULL AND t.revoked_at IS NULL) FOR UPDATE`, vehicle, issuer, subject, client).Scan(&id, &actor, &org, &status)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrUnknownIdentity
	}
	if err != nil {
		return err
	}
	if status == "completed" {
		return nil
	}
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err != nil {
		return err
	}
	if err := requireManager(ctx, tx, snapshot, actor, org); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicle_identities SET status='active',updated_at=now() WHERE vehicle_id=$1`, vehicle); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicles SET status='active' WHERE vehicle_id=$1`, vehicle); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status='completed',credential_ciphertext=NULL,error_code='' WHERE operation_id=$1`, id); err != nil {
		return err
	}
	return commitManagement(ctx, tx, version, actor, org, "", "rotation_completed", map[string]string{"target_id": vehicle, "operation_id": id, "outcome": "applied"})
}

func (s *Store) RotationCompleted(ctx context.Context, issuer, vehicle string) (bool, error) {
	var completed bool
	err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicle_identities i ON i.vehicle_id=l.target_id WHERE i.vehicle_id=$1 AND i.issuer=$2 AND i.client_id=r.client_id AND i.status='active' AND i.binding_version=l.binding_version AND r.status='completed')`, vehicle, issuer).Scan(&completed)
	return completed, err
}

func (s *Store) StartRotation(ctx context.Context, r DeviceRotation) error {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET attempts=attempts+1,next_attempt_at=now()+interval '45 seconds' WHERE operation_id=$1 AND status='pending' AND attempts=$2 AND attempts<3`, r.Operation.ID, r.Attempts)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrConflict
	}
	return tx.Commit()
}
