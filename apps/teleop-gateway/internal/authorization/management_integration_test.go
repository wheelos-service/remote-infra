package authorization

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func managementTestStore(t *testing.T) (*Store, *sql.DB) {
	t.Helper()
	dsn := os.Getenv("AUTHZ_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set AUTHZ_POSTGRES_TEST_DSN for real PostgreSQL management tests")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	schema := "managed_test_" + uuid.NewString()[:8]
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	testConfig := config.Copy()
	testConfig.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*testConfig)
	t.Cleanup(func() { db.Close(); admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); admin.Close() })
	store, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return store, db
}

func TestPostgresBootstrapRejectsRunningGateway(t *testing.T) {
	store, db := managementTestStore(t)
	ctx := context.Background()
	in := BootstrapInput{OrganizationID: testOrgID, OrganizationName: "Offline fleet",
		UserID: testUserID, Name: "Offline operator", Issuer: "https://manual-idp.example.test", Subject: "offline-operator"}
	runtime, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	if _, err := runtime.ExecContext(ctx, `SELECT pg_advisory_lock(7439102342056781)`); err != nil {
		t.Fatal(err)
	}
	defer runtime.ExecContext(ctx, `SELECT pg_advisory_unlock(7439102342056781)`)
	if err := store.Bootstrap(ctx, in); !errors.Is(err, ErrBootstrapGatewayRunning) {
		t.Fatalf("bootstrap while Gateway holds runtime lock = %v", err)
	}
	if version, err := store.Version(ctx); err != nil || version != 0 {
		t.Fatalf("rejected bootstrap version=%d err=%v", version, err)
	}
	if _, err := store.ResolveUser(ctx, in.Issuer, in.Subject); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("rejected bootstrap created identity: %v", err)
	}
	if _, err := runtime.ExecContext(ctx, `SELECT pg_advisory_unlock(7439102342056781)`); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, in); err != nil {
		t.Fatalf("offline bootstrap: %v", err)
	}
	if _, err := runtime.ExecContext(ctx, `SELECT pg_advisory_lock(7439102342056781)`); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, in); !errors.Is(err, ErrBootstrapGatewayRunning) {
		t.Fatalf("repeat bootstrap bypassed running Gateway: %v", err)
	}
	newOrg := in
	newOrg.OrganizationID = uuid.NewString()
	newOrg.UserID = uuid.NewString()
	newOrg.Subject = "new-platform"
	if err := store.Bootstrap(ctx, newOrg); !errors.Is(err, ErrBootstrapGatewayRunning) {
		t.Fatalf("new organization bootstrap bypassed running Gateway: %v", err)
	}
	if version, err := store.Version(ctx); err != nil || version != 1 {
		t.Fatalf("blocked repeat/new organization advanced version=%d err=%v", version, err)
	}
}

func TestPostgresManagedWritesRejectLostLockSession(t *testing.T) {
	store, db := managementTestStore(t)
	ctx := context.Background()
	in := BootstrapInput{OrganizationID: testOrgID, OrganizationName: "Session fleet",
		UserID: testUserID, Name: "Session operator", Issuer: "https://manual-idp.example.test", Subject: "session-operator"}
	if err := store.Bootstrap(ctx, in); err != nil {
		t.Fatal(err)
	}
	target, err := store.RegisterPerson(ctx, in.UserID, in.OrganizationID, in.Issuer, "Target", "session-target")
	if err != nil {
		t.Fatal(err)
	}
	session, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	managed, err := NewManagedStore(db, session)
	if err != nil {
		session.Close()
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := store.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := managed.RegisterPerson(ctx, in.UserID, in.OrganizationID, in.Issuer, "Forbidden", "lost-session"); err == nil {
		t.Fatal("person registration fell back to the pool after losing the runtime session")
	}
	if _, err := managed.RegisterVehicle(ctx, in.UserID, in.OrganizationID, in.Issuer, "lost-session-car", "Forbidden car", "lost-device"); err == nil {
		t.Fatal("vehicle registration fell back to the pool after losing the runtime session")
	}
	if _, err := managed.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: target.UserID,
		OrganizationID: in.OrganizationID, Role: RoleViewer, Scope: ScopeAll}); err == nil {
		t.Fatal("role assignment fell back to the pool after losing the runtime session")
	}
	if after, err := store.Version(ctx); err != nil || after != before {
		t.Fatalf("lost session changed policy version %d -> %d err=%v", before, after, err)
	}
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("fixture pool must remain healthy: %v", err)
	}
	if _, err := NewManagedStore(db, nil); err == nil {
		t.Fatal("managed store accepted a missing lifetime-lock session")
	}
}

func TestPostgresManagedRegistrationAndPrivilegeBoundaries(t *testing.T) {
	store, db := managementTestStore(t)
	ctx := context.Background()
	const issuer = "https://manual-idp.example.test"
	bootstrap := BootstrapInput{OrganizationID: testOrgID, OrganizationName: "First fleet",
		UserID: "55555555-5555-4555-8555-555555555555", Name: "Platform operator", Issuer: issuer, Subject: "platform-subject"}
	if err := store.Bootstrap(ctx, bootstrap); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, bootstrap); err != nil {
		t.Fatalf("idempotent bootstrap: %v", err)
	}
	if version, err := store.Version(ctx); err != nil || version != 1 {
		t.Fatalf("bootstrap version=%d,%v", version, err)
	}
	management, err := store.ManagedContext(ctx, bootstrap.UserID)
	if err != nil || !management.PlatformAdmin || !management.CanBindIdentities || !management.ManualProvisioning || len(management.Organizations) != 1 {
		t.Fatalf("platform context=%+v err=%v", management, err)
	}
	admin, err := store.RegisterPerson(ctx, bootstrap.UserID, testOrgID, issuer, "Organization admin", "admin-subject")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: bootstrap.UserID, UserID: admin.UserID, OrganizationID: testOrgID, Role: RoleOrgAdmin, Scope: ScopeAll}); err != nil {
		t.Fatal(err)
	}
	manager, err := store.ManagedContext(ctx, admin.UserID)
	if err != nil || manager.PlatformAdmin || manager.CanBindIdentities || len(manager.Organizations) != 1 {
		t.Fatalf("org admin context=%+v err=%v", manager, err)
	}
	before, _ := store.Version(ctx)
	if _, err := store.RegisterPerson(ctx, admin.UserID, testOrgID, issuer, "Unverified", "unverified-subject"); !errors.Is(err, ErrIdentityBindingRestricted) {
		t.Fatalf("ordinary identity binding=%v", err)
	}
	if _, err := store.ResolveUser(ctx, issuer, "unverified-subject"); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("failed binding leaked=%v", err)
	}
	if _, err := store.RegisterVehicle(ctx, admin.UserID, testOrgID, issuer, "car-admin", "Invalid binding", "device-admin"); !errors.Is(err, ErrIdentityBindingRestricted) {
		t.Fatalf("ordinary device binding=%v", err)
	}
	after, _ := store.Version(ctx)
	if before != after {
		t.Fatalf("rejected mutations advanced version %d -> %d", before, after)
	}

	person, err := store.RegisterPerson(ctx, bootstrap.UserID, testOrgID, issuer, "Viewer", "viewer-subject")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ManagedContext(ctx, person.UserID); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("unassigned context=%v", err)
	}
	if _, err := store.RegisterPerson(ctx, bootstrap.UserID, testOrgID, issuer, "Replacement name", "viewer-subject"); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate registration=%v", err)
	}
	var canonicalName string
	if err := db.QueryRow(`SELECT name FROM authz_users WHERE user_id=$1`, person.UserID).Scan(&canonicalName); err != nil || canonicalName != "Viewer" {
		t.Fatalf("duplicate mutated name=%q,%v", canonicalName, err)
	}
	v, err := store.RegisterVehicle(ctx, bootstrap.UserID, testOrgID, issuer, "car-a", "Car A", "device-subject")
	if err != nil {
		t.Fatal(err)
	}
	var clientID, secretReference sql.NullString
	var provisioningMode string
	if err := db.QueryRowContext(ctx, `SELECT client_id,secret_reference,provisioning_mode
		FROM authz_vehicle_identities WHERE vehicle_id=$1`, v.VehicleID).Scan(&clientID, &secretReference, &provisioningMode); err != nil {
		t.Fatal(err)
	}
	if clientID.Valid || secretReference.Valid || provisioningMode != "manual" {
		t.Fatalf("manual subject binding misrepresents provider client/credentials: client=%v secret=%v mode=%q",
			clientID.Valid, secretReference.Valid, provisioningMode)
	}
	if _, err := db.ExecContext(ctx, `UPDATE authz_vehicle_identities SET client_id=subject WHERE vehicle_id=$1`, v.VehicleID); err == nil {
		t.Fatal("manual binding accepted an invented client ID")
	}
	if _, err := db.ExecContext(ctx, `UPDATE authz_vehicle_identities SET provisioning_mode='external' WHERE vehicle_id=$1`, v.VehicleID); err == nil {
		t.Fatal("external binding accepted missing verified client/credential references")
	}
	if _, err := store.RegisterVehicle(ctx, bootstrap.UserID, testOrgID, issuer, "car-collision", "Collision", "viewer-subject"); !errors.Is(err, ErrConflict) {
		t.Fatalf("human/device collision=%v", err)
	}
	if _, err := store.ResolveVehicle(ctx, issuer, "viewer-subject"); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("person resolved as vehicle=%v", err)
	}
	resolved, err := store.ResolveVehicle(ctx, issuer, "device-subject")
	if err != nil || resolved.VehicleID != v.VehicleID {
		t.Fatalf("vehicle resolve=%+v,%v", resolved, err)
	}
	for _, role := range []Role{RoleViewer, RoleRemoteOperator, RoleViewer} {
		if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: admin.UserID, UserID: person.UserID, OrganizationID: testOrgID, Role: role, Scope: ScopeSelected, VehicleIDs: []string{"car-a"}}); err != nil {
			t.Fatal(err)
		}
		allowed, err := store.Enforce(ctx, person.UserID, testOrgID, "car-a", ActionRemoteControl)
		if err != nil || allowed != (role == RoleRemoteOperator) {
			t.Fatalf("role=%s control=%v err=%v", role, allowed, err)
		}
	}
	assignment, err := store.UserAssignment(ctx, person.UserID, testOrgID)
	if err != nil || assignment.Role != RoleViewer || assignment.Scope != ScopeSelected || len(assignment.VehicleIDs) != 1 {
		t.Fatalf("assignment=%+v err=%v", assignment, err)
	}
	for _, role := range []Role{RoleOrgAdmin, RoleRemoteOperator} {
		if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: admin.UserID, UserID: admin.UserID, OrganizationID: testOrgID, Role: role, Scope: ScopeAll}); !errors.Is(err, ErrSelfAssignment) {
			t.Fatalf("self role=%s err=%v", role, err)
		}
	}
	if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: admin.UserID, UserID: person.UserID, OrganizationID: testOrgID, Role: RoleMaintainer, Scope: ScopeAll}); !errors.Is(err, ErrInvalidAssignment) {
		t.Fatalf("non-pilot role=%v", err)
	}
	if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: admin.UserID, UserID: person.UserID, OrganizationID: testOrgID, Role: RoleOrgAdmin, Scope: ScopeSelected, VehicleIDs: []string{"car-a"}}); !errors.Is(err, ErrInvalidAssignment) {
		t.Fatalf("selected admin=%v", err)
	}

	other := BootstrapInput{OrganizationID: "44444444-4444-4444-8444-444444444444", OrganizationName: "Other fleet", UserID: "66666666-6666-4666-8666-666666666666", Name: "Other operator", Issuer: issuer, Subject: "other-platform"}
	if err := store.Bootstrap(ctx, other); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ListPeople(ctx, admin.UserID, other.OrganizationID, issuer); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("cross-org list=%v", err)
	}
	foreignPerson, err := store.RegisterPerson(ctx, other.UserID, other.OrganizationID, issuer, "Already bound", "prebound-subject")
	if err != nil {
		t.Fatal(err)
	}
	added, err := store.RegisterPerson(ctx, admin.UserID, testOrgID, issuer, "Do not rename", "prebound-subject")
	if err != nil || added.UserID != foreignPerson.UserID || added.Name != "Already bound" {
		t.Fatalf("org admin adds bound person=%+v err=%v", added, err)
	}
	if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: bootstrap.UserID, UserID: other.UserID, OrganizationID: other.OrganizationID, Role: RoleViewer, Scope: ScopeAll}); !errors.Is(err, ErrLastOrganizationAdmin) {
		t.Fatalf("last admin removal by external platform=%v", err)
	}
	// Repeat bootstrap must never restore a modified principal.
	if _, err := db.Exec(`UPDATE authz_users SET platform_admin=false WHERE user_id=$1`, other.UserID); err != nil {
		t.Fatal(err)
	}
	if err := store.Bootstrap(ctx, other); !errors.Is(err, ErrConflict) {
		t.Fatalf("bootstrap restored privilege=%v", err)
	}
}

func TestPostgresManagedAuditRollbackAndDurableTokenHorizon(t *testing.T) {
	store, db := managementTestStore(t)
	ctx := context.Background()
	in := BootstrapInput{OrganizationID: testOrgID, OrganizationName: "Fleet", UserID: testUserID, Name: "Admin", Issuer: "https://issuer.example.test", Subject: "admin"}
	if err := store.Bootstrap(ctx, in); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE FUNCTION fail_managed_audit() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION 'injected test failure'; END; $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE TRIGGER fail_managed_audit BEFORE INSERT ON authz_audit_events FOR EACH ROW EXECUTE FUNCTION fail_managed_audit()`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RegisterPerson(ctx, in.UserID, testOrgID, in.Issuer, "Rolled back", "rollback-subject"); err == nil {
		t.Fatal("registration succeeded without audit")
	}
	if _, err := store.ResolveUser(ctx, in.Issuer, "rollback-subject"); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("rollback identity=%v", err)
	}
	if version, err := store.Version(ctx); err != nil || version != 1 {
		t.Fatalf("rollback version=%d,%v", version, err)
	}
	expiry := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	if err := store.RecordTokenExpiry(ctx, testOrgID, expiry); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTokenExpiry(ctx, testOrgID, expiry.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	connection, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTokenExpiryOn(ctx, connection, testOrgID, expiry.Add(-time.Minute)); err != nil {
		connection.Close()
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordTokenExpiryOn(ctx, connection, testOrgID, expiry.Add(time.Hour)); err == nil {
		t.Fatal("closed lifetime-lock connection reserved a token through the pool")
	}
	if err := store.RecordTokenExpiryOn(ctx, nil, testOrgID, expiry.Add(time.Hour)); err == nil {
		t.Fatal("missing lifetime-lock connection reserved a token")
	}
	restarted, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	for _, org := range []string{testOrgID, ""} {
		got, err := restarted.TokenExpiry(ctx, org)
		if err != nil || !got.Equal(expiry) {
			t.Fatalf("durable monotonic horizon org=%q got=%s err=%v", org, got, err)
		}
	}
	if err := store.SetDrainQuietUntil(ctx, expiry); err != nil {
		t.Fatal(err)
	}
	if got, err := restarted.DrainQuietUntil(ctx); err != nil || !got.Equal(expiry) {
		t.Fatalf("durable quiet horizon=%s err=%v", got, err)
	}
	if err := restarted.SetDrainQuietUntil(ctx, time.Time{}); err != nil {
		t.Fatal(err)
	}
	if got, err := store.DrainQuietUntil(ctx); err != nil || !got.IsZero() {
		t.Fatalf("cleared quiet horizon=%s err=%v", got, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.TokenExpiry(ctx, ""); err == nil {
		t.Fatal("database outage returned an empty safe horizon")
	}
	if _, err := restarted.ManagedContext(ctx, in.UserID); err == nil {
		t.Fatal("database outage allowed cached management")
	}
}
