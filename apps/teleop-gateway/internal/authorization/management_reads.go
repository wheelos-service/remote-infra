package authorization

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type Registration struct {
	FirstAuthenticatedAt *time.Time `json:"first_authenticated_at"`
	Kind                 string     `json:"kind"`
	TargetID             string     `json:"target_id"`
	Status               string     `json:"status"`
	BindingStatus        string     `json:"binding_status"`
	OperationID          string     `json:"operation_id"`
	Stage                string     `json:"stage"`
	ProvisioningStatus   string     `json:"provisioning_status"`
	ErrorCode            string     `json:"error_code"`
	UpdatedAt            *time.Time `json:"updated_at"`
}

func (s *Store) managementRead(ctx context.Context, actor, org string) (*sql.Tx, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	version, err := readVersion(ctx, tx, false)
	if err == nil {
		var snapshot *engineSnapshot
		snapshot, err = s.snapshotFor(ctx, tx, version)
		if err == nil {
			err = requireManager(ctx, tx, snapshot, actor, org)
		}
	}
	if err != nil {
		tx.Rollback()
		return nil, err
	}
	return tx, nil
}

func (s *Store) Registration(ctx context.Context, actor, org, target, kind string) (Registration, error) {
	result := Registration{Kind: kind, TargetID: target, Stage: "manual", ProvisioningStatus: "manual"}
	tx, err := s.managementRead(ctx, actor, org)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	if kind == "person" {
		if _, err := canonicalUUID(target); err != nil {
			return result, ErrInvalidRegistration
		}
		err = tx.QueryRowContext(ctx, `SELECT m.status,COALESCE((SELECT b.status FROM authz_external_identity_bindings b WHERE b.user_id=m.user_id ORDER BY (b.status='active') DESC LIMIT 1),'unbound') FROM authz_organization_memberships m WHERE m.org_id=$1 AND m.user_id=$2`, org, target).Scan(&result.Status, &result.BindingStatus)
	} else if kind == "vehicle" {
		if !validVehicleID(target) || target == "*" {
			return result, ErrInvalidRegistration
		}
		err = tx.QueryRowContext(ctx, `SELECT v.status,COALESCE(i.status,'unbound') FROM authz_vehicles v LEFT JOIN authz_vehicle_identities i USING(vehicle_id) WHERE v.org_id=$1 AND v.vehicle_id=$2`, org, target).Scan(&result.Status, &result.BindingStatus)
	} else {
		return result, ErrInvalidRegistration
	}
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrInactiveLifecycle
	}
	if err != nil {
		return result, err
	}
	if kind == "person" {
		if err := tx.QueryRowContext(ctx, `SELECT first_authenticated_at FROM authz_users WHERE user_id=$1`, target).Scan(&result.FirstAuthenticatedAt); err != nil {
			return result, err
		}
	}
	err = tx.QueryRowContext(ctx, `SELECT operation_id,stage,CASE WHEN cancelled_at IS NOT NULL THEN 'cancelled' ELSE status END,error_code,updated_at FROM authz_onboarding_operations WHERE (org_id=$1 OR ($2='vehicle' AND vehicle_id=$3)) AND kind=$2 AND (vehicle_id=$3 OR user_id::text=$3) ORDER BY created_at DESC LIMIT 1`, org, kind, target).Scan(&result.OperationID, &result.Stage, &result.ProvisioningStatus, &result.ErrorCode, &result.UpdatedAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if kind == "vehicle" {
		err = tx.QueryRowContext(ctx, `SELECT r.operation_id,'replacement',r.status,r.error_code,l.updated_at FROM authz_device_rotations r JOIN authz_lifecycle_operations l USING(operation_id) JOIN authz_vehicle_identities i ON i.vehicle_id=l.target_id AND i.client_id=r.client_id WHERE l.target_id=$1 ORDER BY l.created_at DESC LIMIT 1`, target).Scan(&result.OperationID, &result.Stage, &result.ProvisioningStatus, &result.ErrorCode, &result.UpdatedAt)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
	}
	return result, tx.Commit()
}

type AuditFilter struct {
	Cursor, Actor, Target, Action, Outcome string
	From, Until                            time.Time
	Limit                                  int
}
type AuditEntry struct {
	ID        string          `json:"id"`
	Actor     string          `json:"actor_user_id"`
	Subject   string          `json:"subject_user_id"`
	Action    string          `json:"action"`
	Version   int64           `json:"authorization_version"`
	Details   json.RawMessage `json:"details"`
	CreatedAt time.Time       `json:"created_at"`
}
type AuditPage struct {
	Items      []AuditEntry `json:"items"`
	NextCursor string       `json:"next_cursor"`
}
type auditCursor struct {
	Org    string    `json:"org"`
	Time   time.Time `json:"time"`
	ID     string    `json:"id"`
	Filter string    `json:"filter"`
}

func (s *Store) Audit(ctx context.Context, actor, org string, f AuditFilter) (AuditPage, error) {
	result := AuditPage{Items: []AuditEntry{}}
	if f.Limit == 0 {
		f.Limit = 25
	}
	if f.Limit < 1 || f.Limit > 100 || len(f.Cursor) > 2048 || len(f.Target) > 128 || len(f.Action) > 100 || len(f.Outcome) > 40 {
		return result, ErrInvalidRegistration
	}
	if f.Actor != "" {
		if _, err := canonicalUUID(f.Actor); err != nil {
			return result, ErrInvalidRegistration
		}
	}
	if f.Outcome != "" && f.Outcome != "applied" && f.Outcome != "failed" {
		return result, ErrInvalidRegistration
	}
	if f.From.IsZero() {
		f.From = time.Unix(0, 0)
	}
	if f.Until.IsZero() {
		f.Until = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	if !f.Until.After(f.From) {
		return result, ErrInvalidRegistration
	}
	signature := strings.Join([]string{f.Actor, f.Target, f.Action, f.Outcome, f.From.Format(time.RFC3339Nano), f.Until.Format(time.RFC3339Nano)}, "|")
	cursor := auditCursor{Org: org, Time: f.Until, ID: "ffffffff-ffff-ffff-ffff-ffffffffffff", Filter: signature}
	if f.Cursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(f.Cursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || cursor.Org != org || cursor.Filter != signature || cursor.Time.IsZero() {
			return result, ErrInvalidRegistration
		}
		if _, err := canonicalUUID(cursor.ID); err != nil {
			return result, ErrInvalidRegistration
		}
	}
	tx, err := s.managementRead(ctx, actor, org)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `WITH events AS (
 SELECT event_id,org_id,actor_user_id,subject_user_id,event_type,authorization_version,details,created_at FROM authz_audit_events WHERE org_id=$1
 UNION ALL
 SELECT e.event_id,o.org_id,o.actor_user_id,o.user_id,'onboarding.'||e.event_type,0,
 jsonb_build_object('operation_id',o.operation_id,'target_id',COALESCE(o.user_id::text,NULLIF(o.vehicle_id,''),o.operation_id::text),'error_code',e.error_code,'outcome',CASE WHEN e.error_code='' THEN 'applied' ELSE 'failed' END),e.created_at
 FROM authz_onboarding_events e JOIN authz_onboarding_operations o USING(operation_id) WHERE o.org_id=$1
 ) SELECT event_id,actor_user_id,COALESCE(subject_user_id::text,''),event_type,authorization_version,details,created_at FROM events
WHERE org_id=$1 AND (created_at,event_id)<($2,$3::uuid) AND created_at>=$4 AND created_at<=$5
AND ($6='' OR actor_user_id::text=$6) AND ($7='' OR subject_user_id::text=$7 OR details->>'target_id'=$7 OR details->>'vehicle_id'=$7)
AND ($8='' OR event_type=$8) AND ($9='' OR COALESCE(details->>'outcome','applied')=$9)
ORDER BY created_at DESC,event_id DESC LIMIT $10`, org, cursor.Time, cursor.ID, f.From, f.Until, f.Actor, f.Target, f.Action, f.Outcome, f.Limit+1)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.Actor, &e.Subject, &e.Action, &e.Version, &e.Details, &e.CreatedAt); err != nil {
			rows.Close()
			return result, err
		}
		result.Items = append(result.Items, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	if len(result.Items) > f.Limit {
		result.Items = result.Items[:f.Limit]
		last := result.Items[len(result.Items)-1]
		encoded, err := json.Marshal(auditCursor{Org: org, Time: last.CreatedAt, ID: last.ID, Filter: signature})
		if err != nil {
			return result, err
		}
		result.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	return result, tx.Commit()
}

func (s *Store) RecordAuthenticatedUser(ctx context.Context, user string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE authz_users SET first_authenticated_at=now() WHERE user_id=$1 AND status='active' AND first_authenticated_at IS NULL`, user)
	return err
}
