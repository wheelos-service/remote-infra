package authorization

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type LifecycleRequest struct {
	DestinationOrganizationID string `json:"destination_org_id,omitempty"`
	IdempotencyKey            string `json:"idempotency_key"`
	ExpectedVersion           int64  `json:"expected_version"`
	Reason                    string `json:"reason"`
	VerifiedSubject           string `json:"verified_subject,omitempty"`
}

type LifecycleOperation struct {
	InstallationStatus string    `json:"installation_status"`
	ID                 string    `json:"id"`
	OrganizationID     string    `json:"org_id"`
	ActorUserID        string    `json:"actor_user_id"`
	Action             string    `json:"action"`
	TargetID           string    `json:"target_id"`
	Reason             string    `json:"reason"`
	Version            int64     `json:"authorization_version"`
	ProviderStatus     string    `json:"provider_status"`
	ErrorCode          string    `json:"error_code"`
	Attempts           int       `json:"attempts"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

const lifecycleJSON = `json_build_object('id',operation_id,'org_id',org_id,'actor_user_id',actor_user_id,
'installation_status',COALESCE((SELECT status FROM authz_device_rotations WHERE operation_id=authz_lifecycle_operations.operation_id),''),'action',action,'target_id',target_id,'reason',reason,'authorization_version',authorization_version,
'provider_status',provider_status,'error_code',COALESCE(NULLIF((SELECT error_code FROM authz_device_rotations WHERE operation_id=authz_lifecycle_operations.operation_id),''),error_code),'attempts',attempts,'created_at',created_at,'updated_at',updated_at)`

func (s *Store) Lifecycle(ctx context.Context, actor, org, target, action string, in LifecycleRequest, automated bool, credentials ...[]byte) (LifecycleOperation, error) {
	var result LifecycleOperation
	if _, err := canonicalUUID(in.IdempotencyKey); err != nil || in.ExpectedVersion < 0 || !validText(in.Reason, 500) {
		return result, ErrInvalidRegistration
	}
	if strings.HasPrefix(action, "member_") {
		if _, err := canonicalUUID(target); err != nil {
			return result, ErrInvalidRegistration
		}
	} else if !validVehicleID(target) || target == "*" {
		return result, ErrInvalidRegistration
	}
	encoded, _ := json.Marshal(struct {
		Target, Action string
		Request        LifecycleRequest
	}{target, action, in})
	hash := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(hash[:])
	tx, version, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var prior, priorActor string
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,actor_user_id,`+lifecycleJSON+` FROM authz_lifecycle_operations WHERE org_id=$1 AND idempotency_key=$2`, org, in.IdempotencyKey).Scan(&prior, &priorActor, &raw)
	if err == nil {
		if prior != fingerprint || priorActor != actor {
			return result, ErrConflict
		}
		err = json.Unmarshal(raw, &result)
		return result, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if version != in.ExpectedVersion {
		return result, ErrConflict
	}
	var platform bool
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1`, actor).Scan(&platform); err != nil {
		return result, err
	}
	providerStatus, providerName, clientID := "not_required", "", ""
	var bindingVersion int64
	before := ""
	switch action {
	case "member_remove", "member_rejoin":
		if err := tx.QueryRowContext(ctx, `SELECT status FROM authz_organization_memberships WHERE org_id=$1 AND user_id=$2 FOR UPDATE`, org, target).Scan(&before); err != nil {
			return result, ErrInactiveLifecycle
		}
		snapshot, err := s.snapshotFor(ctx, tx, version)
		if err != nil {
			return result, err
		}
		if action == "member_remove" {
			if before != "active" {
				return result, ErrConflict
			}
			if snapshot.canManageOrganization(target, org) && !platform {
				other, err := hasOtherOrganizationAdmin(ctx, tx, snapshot, org, target)
				if err != nil {
					return result, err
				}
				if !other {
					return result, ErrLastOrganizationAdmin
				}
			}
		} else {
			if before != "removed" {
				return result, ErrConflict
			}
			var active bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_users u JOIN authz_external_identity_bindings b USING(user_id) WHERE u.user_id=$1 AND u.status='active' AND b.status='active')`, target).Scan(&active); err != nil {
				return result, err
			}
			if !active {
				return result, ErrUnknownIdentity
			}
		}
		assignment := Assignment{ActorUserID: actor, UserID: target, OrganizationID: org, Role: RoleViewer, Scope: ScopeNone}
		var rules []policyRule
		status := "removed"
		if action == "member_rejoin" {
			status = "active"
			rules = assignmentRules(assignment, "grant:"+uuid.NewString())
		}
		if err := replaceUserAssignment(ctx, tx, assignment, rules); err != nil {
			return result, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE authz_organization_memberships SET status=$3,updated_at=now() WHERE org_id=$1 AND user_id=$2`, org, target, status); err != nil {
			return result, err
		}
		if action == "member_remove" {
			if _, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status='cancelled',credential_ciphertext=NULL WHERE operation_id IN(SELECT operation_id FROM authz_lifecycle_operations WHERE org_id=$1 AND actor_user_id=$2) AND status<>'completed'`, org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_rotation_tickets SET revoked_at=now() WHERE operation_id IN(SELECT operation_id FROM authz_lifecycle_operations WHERE org_id=$1 AND actor_user_id=$2) AND revoked_at IS NULL`, org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET cancelled_at=now(),credential_ciphertext=NULL,updated_at=now() WHERE org_id=$1 AND (user_id=$2 OR planned_identity_id=$2 OR actor_user_id=$2) AND status<>'completed'`, org, target); err != nil {
				return result, err
			}
		}
	case "vehicle_remove", "vehicle_reactivate", "credential_revoke", "credential_rotate", "vehicle_transfer":
		var binding, subject string
		recoverRevoked := false
		if err := tx.QueryRowContext(ctx, `SELECT v.status,i.status,i.subject,COALESCE(i.client_id,''),i.binding_version FROM authz_vehicles v JOIN authz_vehicle_identities i USING(vehicle_id) WHERE v.org_id=$1 AND v.vehicle_id=$2 FOR UPDATE`, org, target).Scan(&before, &binding, &subject, &clientID, &bindingVersion); err != nil {
			return result, ErrInactiveLifecycle
		}
		if action == "credential_rotate" {
			var installed bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_onboarding_operations WHERE vehicle_id=$1 AND client_id=$2 AND status='completed') OR EXISTS(SELECT 1 FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) WHERE l.target_id=$1 AND r.client_id=$2 AND r.status IN ('completed','awaiting_install','cancelled'))`, target, clientID).Scan(&installed); err != nil {
				return result, err
			}
			if !installed {
				return result, ErrConflict
			}
			if binding == "revoked" {
				if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_lifecycle_operations WHERE target_id=$1 AND binding_version=$2 AND action IN ('credential_revoke','credential_rotate') AND provider_status='confirmed') AND NOT EXISTS(SELECT 1 FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) WHERE l.target_id=$1 AND r.status IN ('pending','awaiting_install'))`, target, bindingVersion).Scan(&recoverRevoked); err != nil {
					return result, err
				}
			}
		}
		if action == "vehicle_transfer" {
			if !platform {
				return result, ErrIdentityBindingRestricted
			}
			if _, err := canonicalUUID(in.DestinationOrganizationID); err != nil || in.DestinationOrganizationID == org {
				return result, ErrInvalidRegistration
			}
			var destinationActive, incomplete bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_organizations WHERE org_id=$1 AND status='active')`, in.DestinationOrganizationID).Scan(&destinationActive); err != nil {
				return result, err
			}
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_onboarding_operations WHERE vehicle_id=$1 AND status<>'completed')`, target).Scan(&incomplete); err != nil {
				return result, err
			}
			if !destinationActive || incomplete || binding != "active" || in.VerifiedSubject != subject {
				return result, ErrConflict
			}
		}
		if action == "vehicle_reactivate" {
			if !platform {
				return result, ErrIdentityBindingRestricted
			}
			if before != "disabled" || binding != "active" || in.VerifiedSubject != subject {
				return result, ErrConflict
			}
			var unresolved bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_lifecycle_operations WHERE org_id=$1 AND target_id=$2 AND binding_version=$3 AND action='credential_revoke')`, org, target, bindingVersion).Scan(&unresolved); err != nil {
				return result, err
			}
			if unresolved {
				return result, ErrConflict
			}
			var incomplete bool
			if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_onboarding_operations WHERE org_id=$1 AND vehicle_id=$2 AND status<>'completed')`, org, target).Scan(&incomplete); err != nil {
				return result, err
			}
			if incomplete {
				return result, ErrConflict
			}

			if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicles SET status='active' WHERE vehicle_id=$1`, target); err != nil {
				return result, err
			}
		} else {
			if action == "vehicle_remove" && before != "active" && binding != "pending" {
				return result, ErrConflict
			}
			if (action == "credential_revoke" || action == "credential_rotate") && binding != "active" && binding != "pending" && !recoverRevoked {
				return result, ErrConflict
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicles SET status='disabled' WHERE vehicle_id=$1`, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM casbin_rule p WHERE p.ptype='p' AND p.v0=$1 AND p.v4='selected' AND p.v5=$2 AND EXISTS(SELECT 1 FROM casbin_rule other WHERE other.ptype='p' AND other.v0=p.v0 AND other.v1=p.v1 AND other.v4='selected' AND other.v5<>$2)`, "org:"+org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE casbin_rule SET v4='none',v5='' WHERE ptype='p' AND v0=$1 AND v4='selected' AND v5=$2`, "org:"+org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_installation_tickets SET revoked_at=now() WHERE operation_id IN (SELECT operation_id FROM authz_onboarding_operations WHERE org_id=$1 AND vehicle_id=$2) AND revoked_at IS NULL`, org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET cancelled_at=now(),credential_ciphertext=NULL,updated_at=now() WHERE org_id=$1 AND vehicle_id=$2`, org, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_rotation_tickets SET revoked_at=now() WHERE operation_id IN(SELECT operation_id FROM authz_lifecycle_operations WHERE target_id=$1) AND revoked_at IS NULL`, target); err != nil {
				return result, err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status='cancelled',credential_ciphertext=NULL WHERE operation_id IN(SELECT operation_id FROM authz_lifecycle_operations WHERE target_id=$1) AND status<>'completed'`, target); err != nil {
				return result, err
			}
			if action == "vehicle_transfer" {
				if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicles SET org_id=$2 WHERE vehicle_id=$1`, target, in.DestinationOrganizationID); err != nil {
					return result, err
				}
				details, err := json.Marshal(map[string]string{"target_id": target, "source_org_id": org, "reason": in.Reason, "outcome": "applied"})
				if err != nil {
					return result, err
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO authz_audit_events(event_id,org_id,actor_user_id,event_type,authorization_version,details) VALUES($1,$2,$3,'vehicle_transferred_in',$4,$5)`, uuid.NewString(), in.DestinationOrganizationID, actor, version+1, details); err != nil {
					return result, err
				}
			}
			if action == "credential_revoke" || action == "credential_rotate" {
				bindingVersion++
				if _, err := tx.ExecContext(ctx, `UPDATE authz_vehicle_identities SET status='revoked',binding_version=$2,updated_at=now() WHERE vehicle_id=$1`, target, bindingVersion); err != nil {
					return result, err
				}
				providerStatus = "manual_required"
				if automated && clientID != "" {
					err := tx.QueryRowContext(ctx, `SELECT provider_name FROM authz_onboarding_operations WHERE vehicle_id=$1 AND client_id=$2 UNION ALL SELECT r.provider_name FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) WHERE l.target_id=$1 AND r.client_id=$2 LIMIT 1`, target, clientID).Scan(&providerName)
					if err != nil && !errors.Is(err, sql.ErrNoRows) {
						return result, err
					}
					if providerName != "" {
						providerStatus = "pending"
					}
				}
			}
		}
	default:
		return result, ErrInvalidRegistration
	}
	if action == "credential_rotate" && (!automated || providerName == "" || len(credentials) != 1 || len(credentials[0]) < 28 || len(credentials[0]) > 4096) {
		return result, ErrInvalidRegistration
	}
	result = LifecycleOperation{ID: uuid.NewString(), OrganizationID: org, ActorUserID: actor, Action: action, TargetID: target, Reason: in.Reason, Version: version + 1, ProviderStatus: providerStatus}
	err = tx.QueryRowContext(ctx, `INSERT INTO authz_lifecycle_operations(operation_id,org_id,actor_user_id,idempotency_key,fingerprint,action,target_id,reason,authorization_version,provider_status,provider_name,client_id,binding_version)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING created_at,updated_at`, result.ID, org, actor, in.IdempotencyKey, fingerprint, action, target, in.Reason, result.Version, providerStatus, providerName, clientID, bindingVersion).Scan(&result.CreatedAt, &result.UpdatedAt)
	if err != nil {
		return result, mutationError(err)
	}
	if action == "credential_rotate" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO authz_device_rotations(operation_id,provider_name,client_id,credential_ciphertext,status) VALUES($1,$2,$3,$4,'pending')`, result.ID, "teleop-"+strings.ReplaceAll(result.ID, "-", ""), uuid.NewString(), credentials[0]); err != nil {
			return result, err
		}
		result.InstallationStatus = "pending"
	}
	after := "disabled"
	if action == "member_remove" {
		after = "removed"
	}
	if action == "member_rejoin" || action == "vehicle_reactivate" {
		after = "active"
	}
	if action == "credential_revoke" || action == "credential_rotate" {
		after = "revoked"
	}
	err = commitManagement(ctx, tx, version, actor, org, "", action, map[string]string{"target_id": target, "operation_id": result.ID, "reason": in.Reason, "before": before, "after": after, "outcome": "applied", "destination_org_id": in.DestinationOrganizationID})
	return result, err
}

func (s *Store) ListLifecycle(ctx context.Context, actor, org string) ([]LifecycleOperation, error) {
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrNotOrganizationAdmin
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+lifecycleJSON+` FROM authz_lifecycle_operations WHERE org_id=$1 ORDER BY created_at DESC,operation_id DESC LIMIT 100`, org)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []LifecycleOperation{}
	for rows.Next() {
		var raw []byte
		var op LifecycleOperation
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &op); err != nil {
			return nil, err
		}
		result = append(result, op)
	}
	return result, rows.Err()
}

func (s *Store) GetLifecycle(ctx context.Context, actor, org, id string) (LifecycleOperation, error) {
	var op LifecycleOperation
	if _, err := canonicalUUID(id); err != nil {
		return op, ErrInvalidRegistration
	}
	allowed, err := s.CanManageOrganization(ctx, actor, org)
	if err != nil {
		return op, err
	}
	if !allowed {
		return op, ErrNotOrganizationAdmin
	}
	var raw []byte
	if err := s.db.QueryRowContext(ctx, `SELECT `+lifecycleJSON+` FROM authz_lifecycle_operations WHERE org_id=$1 AND operation_id=$2`, org, id).Scan(&raw); err != nil {
		return op, ErrConflict
	}
	err = json.Unmarshal(raw, &op)
	return op, err
}

type RevocationWork struct {
	ID, OrganizationID, VehicleID, ProviderName, ClientID string
	BindingVersion                                        int64
	Attempts                                              int
}

func (s *Store) NextRevocation(ctx context.Context) (RevocationWork, error) {
	var op RevocationWork
	err := s.db.QueryRowContext(ctx, `SELECT operation_id,org_id,target_id,provider_name,client_id,binding_version,attempts FROM authz_lifecycle_operations WHERE action IN ('credential_revoke','credential_rotate') AND provider_status='pending' AND next_attempt_at<=now() AND attempts<3 ORDER BY created_at LIMIT 1`).Scan(&op.ID, &op.OrganizationID, &op.VehicleID, &op.ProviderName, &op.ClientID, &op.BindingVersion, &op.Attempts)
	return op, err
}

func (s *Store) RecordRevocation(ctx context.Context, op RevocationWork, code string) error {
	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var current bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM authz_vehicle_identities WHERE vehicle_id=$1 AND binding_version=$2 AND status='revoked')`, op.VehicleID, op.BindingVersion).Scan(&current); err != nil {
		return err
	}
	if !current {
		return ErrConflict
	}
	status := "confirmed"
	if code != "" {
		status = "pending"
		if op.Attempts >= 2 {
			status = "failed"
		}
	}
	if code != "" && !validOnboardingError(code) {
		return ErrInvalidRegistration
	}
	result, err := tx.ExecContext(ctx, `UPDATE authz_lifecycle_operations SET provider_status=$2,error_code=$3,attempts=attempts+1,next_attempt_at=now()+interval '30 seconds',updated_at=now() WHERE operation_id=$1 AND provider_status='pending' AND attempts=$4`, op.ID, status, code, op.Attempts)
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
	version, err := readVersion(ctx, tx, true)
	if err != nil {
		return err
	}
	var actor string
	if err := tx.QueryRowContext(ctx, `SELECT actor_user_id FROM authz_lifecycle_operations WHERE operation_id=$1`, op.ID).Scan(&actor); err != nil {
		return err
	}
	outcome := "applied"
	if code != "" {
		outcome = "failed"
	}
	return commitManagement(ctx, tx, version, actor, op.OrganizationID, "", "provider_revocation_"+status, map[string]string{"target_id": op.VehicleID, "operation_id": op.ID, "provider_status": status, "error_code": code, "outcome": outcome})
}

func (s *Store) ReconcileLifecycle(ctx context.Context, actor, org, id, action, reason string) error {
	if !validText(reason, 500) {
		return ErrInvalidRegistration
	}
	tx, version, err := s.managementTx(ctx, actor, org)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var platform bool
	if err := tx.QueryRowContext(ctx, `SELECT platform_admin FROM authz_users WHERE user_id=$1`, actor).Scan(&platform); err != nil {
		return err
	}
	var result sql.Result
	if action == "confirm" {
		if !platform {
			return ErrIdentityBindingRestricted
		}
		result, err = tx.ExecContext(ctx, `UPDATE authz_lifecycle_operations SET provider_status='confirmed',error_code='',updated_at=now() WHERE operation_id=$1 AND org_id=$2 AND provider_status='manual_required'`, id, org)
	} else if action == "retry" {
		rotation, err := tx.ExecContext(ctx, `UPDATE authz_device_rotations SET status='pending',attempts=0,error_code='',next_attempt_at=now() WHERE operation_id=$1 AND status='failed' AND operation_id IN(SELECT operation_id FROM authz_lifecycle_operations WHERE org_id=$2)`, id, org)
		if err != nil {
			return err
		}
		if n, _ := rotation.RowsAffected(); n == 1 {
			return commitManagement(ctx, tx, version, actor, org, "", "rotation_retry", map[string]string{"operation_id": id, "reason": reason, "outcome": "applied"})
		}

		result, err = tx.ExecContext(ctx, `UPDATE authz_lifecycle_operations SET provider_status='pending',attempts=0,error_code='',next_attempt_at=now(),updated_at=now() WHERE operation_id=$1 AND org_id=$2 AND provider_status='failed'`, id, org)
	} else {
		return ErrInvalidRegistration
	}
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
	return commitManagement(ctx, tx, version, actor, org, "", "revocation_"+action, map[string]string{"operation_id": id, "reason": reason, "outcome": "applied"})
}
