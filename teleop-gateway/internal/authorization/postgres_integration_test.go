package authorization

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestPostgresAuthorizationLifecycleAndTransactionalStore(t *testing.T) {
	dsn := os.Getenv("AUTHZ_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set AUTHZ_POSTGRES_TEST_DSN to run PostgreSQL authorization integration tests")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	adminConfig, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse PostgreSQL test DSN: %v", err)
	}
	adminDB := stdlib.OpenDB(*adminConfig)
	adminDB.SetMaxOpenConns(2)
	if err := adminDB.PingContext(ctx); err != nil {
		adminDB.Close()
		t.Fatalf("connect to PostgreSQL test database: %v", err)
	}

	schema := "authz_test_" + uuid.NewString()[:8]
	if _, err := adminDB.ExecContext(ctx, `CREATE SCHEMA `+schema); err != nil {
		adminDB.Close()
		t.Fatalf("create isolated PostgreSQL test schema: %v", err)
	}
	var testDB *sql.DB
	t.Cleanup(func() {
		if testDB != nil {
			_ = testDB.Close()
		}
		_, _ = adminDB.ExecContext(context.Background(), `DROP SCHEMA `+schema+` CASCADE`)
		_ = adminDB.Close()
	})

	testConfig := adminConfig.Copy()
	if testConfig.RuntimeParams == nil {
		testConfig.RuntimeParams = make(map[string]string)
	}
	testConfig.RuntimeParams["search_path"] = schema
	testDB = stdlib.OpenDB(*testConfig)
	testDB.SetMaxOpenConns(4)
	store, err := NewStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("migrate PostgreSQL authorization schema: %v", err)
	}

	const (
		org1   = "22222222-2222-4222-8222-222222222222"
		org2   = "44444444-4444-4444-8444-444444444444"
		admin  = "55555555-5555-4555-8555-555555555555"
		target = "11111111-1111-4111-8111-111111111111"
	)
	for _, row := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO authz_organizations (org_id, status) VALUES ($1, 'active'), ($2, 'active')`, []any{org1, org2}},
		{`INSERT INTO authz_users (user_id, status) VALUES ($1, 'active'), ($2, 'active')`, []any{admin, target}},
		{`INSERT INTO authz_organization_memberships (org_id, user_id, status) VALUES ($1, $2, 'active'), ($1, $3, 'active')`, []any{org1, admin, target}},
		{`INSERT INTO authz_vehicles (vehicle_id, org_id, status) VALUES ('car-a', $1, 'active'), ('car-b', $1, 'active'), ('car-other', $2, 'active')`, []any{org1, org2}},
	} {
		if _, err := testDB.ExecContext(ctx, row.query, row.args...); err != nil {
			t.Fatalf("insert PostgreSQL lifecycle fixture: %v", err)
		}
	}
	if _, err := testDB.ExecContext(ctx, `
		INSERT INTO authz_users (user_id, status)
		VALUES ('66666666-6666-4666-8666-666666666666', 'active')`); err != nil {
		t.Fatalf("insert additional organization user: %v", err)
	}
	if _, err := testDB.ExecContext(ctx, `
		INSERT INTO authz_organization_memberships (org_id, user_id, status)
		VALUES ($1, '66666666-6666-4666-8666-666666666666', 'active')`, org1); err != nil {
		t.Fatalf("insert additional organization member: %v", err)
	}
	seedInitialAdmin(t, ctx, testDB, org1, admin)

	otherInstance, err := NewStore(testDB)
	if err != nil {
		t.Fatal(err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionRemoteControl); err != nil || allowed {
		t.Fatalf("unassigned member Enforce() = (%v, %v), want (false, nil)", allowed, err)
	}
	for _, action := range []string{ActionVehicleRead, ActionCameraLiveView, ActionTaskRead} {
		if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-b", action); err != nil || !allowed {
			t.Fatalf("existing roleless member baseline %s = %v, %v", action, allowed, err)
		}
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-other", ActionCameraLiveView); err != nil || allowed {
		t.Fatalf("roleless baseline crossed organizations: %v %v", allowed, err)
	}

	foreignVehicle := Assignment{
		ActorUserID: admin, UserID: target, OrganizationID: org1,
		Role: RoleViewer, Scope: ScopeSelected, VehicleIDs: []string{"car-other"},
	}
	if _, err := store.AssignRole(ctx, foreignVehicle); err != ErrInactiveLifecycle {
		t.Fatalf("cross-organization selected assignment error = %v, want %v", err, ErrInactiveLifecycle)
	}
	assertIdentityBindingConstraints(t, ctx, testDB, target)

	nonAdmin := Assignment{
		ActorUserID: target, UserID: "66666666-6666-4666-8666-666666666666", OrganizationID: org1,
		Role: RoleViewer, Scope: ScopeAll,
	}
	if _, err := store.AssignRole(ctx, nonAdmin); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("non-admin assignment error = %v, want %v", err, ErrNotOrganizationAdmin)
	}
	selfAssignment := Assignment{
		ActorUserID: admin, UserID: admin, OrganizationID: org1,
		Role: RoleViewer, Scope: ScopeAll,
	}
	if _, err := store.AssignRole(ctx, selfAssignment); !errors.Is(err, ErrSelfAssignment) {
		t.Fatalf("self-assignment error = %v, want %v", err, ErrSelfAssignment)
	}
	assertAuthorizationState(t, ctx, testDB, 1, 0, 0)

	if _, err := testDB.ExecContext(ctx, `
		CREATE FUNCTION authz_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected test failure'; END; $$`); err != nil {
		t.Fatalf("install rollback test function: %v", err)
	}
	if _, err := testDB.ExecContext(ctx, `
		CREATE TRIGGER authz_test_fail_audit BEFORE INSERT ON authz_audit_events
		FOR EACH ROW EXECUTE FUNCTION authz_test_fail_audit()`); err != nil {
		t.Fatalf("install rollback test trigger: %v", err)
	}
	operator := Assignment{
		ActorUserID: admin, UserID: target, OrganizationID: org1,
		Role: RoleRemoteOperator, Scope: ScopeSelected, VehicleIDs: []string{"car-a"},
	}
	if _, err := store.AssignRole(ctx, operator); err == nil {
		t.Fatal("AssignRole() succeeded despite an audit insert failure")
	}
	version, err := store.Version(ctx)
	if err != nil || version != 1 {
		t.Fatalf("version after rollback = (%d, %v), want (1, nil)", version, err)
	}
	assertNoTargetPolicy(t, ctx, testDB, target, org1)
	if _, err := testDB.ExecContext(ctx, `DROP TRIGGER authz_test_fail_audit ON authz_audit_events`); err != nil {
		t.Fatalf("remove rollback test trigger: %v", err)
	}
	if _, err := testDB.ExecContext(ctx, `DROP FUNCTION authz_test_fail_audit()`); err != nil {
		t.Fatalf("remove rollback test trigger: %v", err)
	}

	version, err = store.AssignRole(ctx, operator)
	if err != nil || version != 2 {
		t.Fatalf("AssignRole() = (%d, %v), want (2, nil)", version, err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionRemoteControl); err != nil || !allowed {
		t.Fatalf("fresh operator Enforce() = (%v, %v), want (true, nil)", allowed, err)
	}
	assertConcurrentEnforce(t, ctx, otherInstance, target, org1, "car-a", ActionRemoteControl)
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-b", ActionRemoteControl); err != nil || allowed {
		t.Fatalf("selected-scope Enforce() = (%v, %v), want (false, nil)", allowed, err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-other", ActionVehicleRead); err != nil || allowed {
		t.Fatalf("cross-organization vehicle Enforce() = (%v, %v), want (false, nil)", allowed, err)
	}

	if _, err := testDB.ExecContext(ctx, `
		UPDATE authz_organization_memberships SET status = 'suspended'
		WHERE org_id = $1 AND user_id = $2`, org1, target); err != nil {
		t.Fatal(err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionVehicleRead); err != nil || allowed {
		t.Fatalf("suspended-member Enforce() = (%v, %v), want (false, nil)", allowed, err)
	}
	if _, err := testDB.ExecContext(ctx, `
		UPDATE authz_organization_memberships SET status = 'active'
		WHERE org_id = $1 AND user_id = $2`, org1, target); err != nil {
		t.Fatal(err)
	}

	viewer := Assignment{
		ActorUserID: admin, UserID: target, OrganizationID: org1,
		Role: RoleViewer, Scope: ScopeSelected, VehicleIDs: []string{"car-a"},
	}
	version, err = store.AssignRole(ctx, viewer)
	if err != nil || version != 3 {
		t.Fatalf("viewer reassignment = (%d, %v), want (3, nil)", version, err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionRemoteControl); err != nil || allowed {
		t.Fatalf("stale-positive control Enforce() = (%v, %v), want (false, nil)", allowed, err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionVehicleRead); err != nil || !allowed {
		t.Fatalf("fresh viewer Enforce() = (%v, %v), want (true, nil)", allowed, err)
	}

	var auditCount, outboxCount int
	if err := testDB.QueryRowContext(ctx, `SELECT count(*) FROM authz_audit_events`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := testDB.QueryRowContext(ctx, `SELECT count(*) FROM authz_outbox`).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 2 || outboxCount != 2 {
		t.Fatalf("audit/outbox counts = %d/%d, want 2/2 after two committed role changes", auditCount, outboxCount)
	}

	if _, err := testDB.ExecContext(ctx, `UPDATE authz_authorization_state SET version = 4 WHERE state_key = 1`); err != nil {
		t.Fatalf("advance authorization version to force snapshot reload: %v", err)
	}
	if _, err := testDB.ExecContext(ctx, `ALTER TABLE casbin_rule RENAME TO casbin_rule_unavailable`); err != nil {
		t.Fatalf("simulate policy-store outage: %v", err)
	}
	allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionVehicleRead)
	if err == nil || allowed {
		t.Fatalf("Enforce() during policy-store outage = (%v, %v), want (false, error)", allowed, err)
	}
	if _, err := testDB.ExecContext(ctx, `ALTER TABLE casbin_rule_unavailable RENAME TO casbin_rule`); err != nil {
		t.Fatalf("restore policy table after outage test: %v", err)
	}
	if allowed, err := otherInstance.Enforce(ctx, target, org1, "car-a", ActionVehicleRead); err != nil || !allowed {
		t.Fatalf("Enforce() after restoring policy store = (%v, %v), want (true, nil)", allowed, err)
	}
}

func assertIdentityBindingConstraints(t *testing.T, ctx context.Context, db *sql.DB, userID string) {
	t.Helper()
	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_identity_subjects (issuer, subject, identity_kind)
		VALUES ('https://issuer.example', 'shared-subject', 'user')`); err != nil {
		t.Fatalf("insert user identity subject fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_external_identity_bindings (issuer, subject, user_id, status)
		VALUES ('https://issuer.example', 'shared-subject', $1, 'active')`, userID); err != nil {
		t.Fatalf("insert user identity fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_vehicle_identities
			(vehicle_id, issuer, client_id, subject, binding_version, status, secret_reference)
		VALUES ('car-a', 'https://issuer.example', 'machine-shared', 'shared-subject', 1, 'active', 'secret/ref')`); err == nil {
		t.Fatal("vehicle identity reused an issuer/subject already bound as a user")
	}

	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_identity_subjects (issuer, subject, identity_kind)
		VALUES ('https://issuer.example', 'vehicle-subject', 'vehicle')`); err != nil {
		t.Fatalf("insert vehicle identity subject fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_vehicle_identities
			(vehicle_id, issuer, client_id, subject, binding_version, status, secret_reference)
		VALUES ('car-a', 'https://issuer.example', 'machine-a', 'vehicle-subject', 1, 'active', 'secret/a')`); err != nil {
		t.Fatalf("insert first vehicle identity fixture: %v", err)
	}
	if _, err := db.ExecContext(ctx, `
		INSERT INTO authz_vehicle_identities
			(vehicle_id, issuer, client_id, subject, binding_version, status, secret_reference)
		VALUES ('car-b', 'https://issuer.example', 'machine-b', 'vehicle-subject', 1, 'active', 'secret/b')`); err == nil {
		t.Fatal("machine issuer/subject was bound to two vehicles")
	}
}

func assertAuthorizationState(t *testing.T, ctx context.Context, db *sql.DB, wantVersion, wantAudit, wantOutbox int) {
	t.Helper()
	var version, auditCount, outboxCount int
	if err := db.QueryRowContext(ctx, `SELECT version FROM authz_authorization_state WHERE state_key = 1`).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM authz_audit_events`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM authz_outbox`).Scan(&outboxCount); err != nil {
		t.Fatal(err)
	}
	if version != wantVersion || auditCount != wantAudit || outboxCount != wantOutbox {
		t.Fatalf("authorization state = version:%d audit:%d outbox:%d, want %d/%d/%d",
			version, auditCount, outboxCount, wantVersion, wantAudit, wantOutbox)
	}
}

func assertConcurrentEnforce(t *testing.T, ctx context.Context, store *Store, userID, orgID, vehicleID, action string) {
	t.Helper()
	const workers, iterations = 8, 10
	errs := make(chan error, workers*iterations)
	var wait sync.WaitGroup
	for range workers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for range iterations {
				allowed, err := store.Enforce(ctx, userID, orgID, vehicleID, action)
				if err != nil {
					errs <- err
					return
				}
				if !allowed {
					errs <- errors.New("concurrent authorization unexpectedly denied")
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func seedInitialAdmin(t *testing.T, ctx context.Context, db *sql.DB, orgID, userID string) {
	t.Helper()
	assignment := Assignment{
		UserID: userID, OrganizationID: orgID,
		Role: RoleOrgAdmin, Scope: ScopeAll,
	}
	rules := assignmentRules(assignment, "grant:"+uuid.NewString())
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, rule := range rules {
		var values [6]string
		copy(values[:], rule.values)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			rule.kind, values[0], values[1], values[2], values[3], values[4], values[5]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE authz_authorization_state SET version = 1 WHERE state_key = 1`); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func assertNoTargetPolicy(t *testing.T, ctx context.Context, db *sql.DB, userID, orgID string) {
	t.Helper()
	var count int
	err := db.QueryRowContext(ctx, `
		SELECT count(*) FROM casbin_rule
		WHERE (ptype = 'g' AND v0 = $1 AND v2 = $2)
		   OR (ptype = 'p' AND v0 = $2 AND v1 IN (
		       SELECT v1 FROM casbin_rule WHERE ptype = 'g' AND v0 = $1 AND v2 = $2
		   ))`, "user:"+userID, "org:"+orgID).Scan(&count)
	if err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("found %d uncommitted policy rows for %s in %s", count, userID, orgID)
	}
}
