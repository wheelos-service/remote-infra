package authorization

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func onboardingBootstrap(t *testing.T, store *Store) BootstrapInput {
	t.Helper()
	in := BootstrapInput{OrganizationID: testOrgID, OrganizationName: "Onboarding fleet",
		UserID: testUserID, Name: "Platform operator", Issuer: "https://onboarding.example.test", Subject: "platform-subject"}
	if err := store.Bootstrap(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	return in
}

func TestPostgresOnboardingFreshAtomicRolesAndIdempotency(t *testing.T) {
	store, db := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	request := OnboardingRequest{Kind: "person", Name: "New operator", Email: "new@example.test", Role: RoleRemoteOperator, Scope: ScopeAll, IdempotencyKey: uuid.NewString()}
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	duplicate, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, nil)
	if err != nil || duplicate.ID != op.ID {
		t.Fatalf("idempotent plan = %s, %v", duplicate.ID, err)
	}
	request.Name = "Changed name"
	if _, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, nil); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed idempotent request = %v", err)
	}
	if _, err := store.ResolveUser(ctx, in.Issuer, op.PlannedIdentityID); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("planned identity activated early: %v", err)
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, op.PlannedIdentityID); err != nil {
		t.Fatal(err)
	}
	person, err := store.UserAssignment(ctx, op.PlannedIdentityID, in.OrganizationID)
	if err != nil || person.Role != RoleRemoteOperator {
		t.Fatalf("atomic first role = %+v, %v", person, err)
	}
	op, err = store.GetOnboarding(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || op.Stage != "invitation" || op.Status != "running" {
		t.Fatalf("bound invitation stage = %+v %v", op, err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, op.PlannedIdentityID); !errors.Is(err, ErrConflict) {
		t.Fatalf("rebind accepted: %v", err)
	}
	if err := store.CompleteInvitation(ctx, op); err != nil {
		t.Fatal(err)
	}
	var audits int
	if err := db.QueryRow(`SELECT count(*) FROM authz_onboarding_events WHERE operation_id=$1`, op.ID).Scan(&audits); err != nil || audits < 3 {
		t.Fatalf("lifecycle audit count=%d err=%v", audits, err)
	}
}

func TestPostgresOnboardingDefaultsToOrganizationReadWithoutExecution(t *testing.T) {
	store, _ := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, OnboardingRequest{
		Kind: "person", Name: "Unassigned person", Email: "unassigned@example.test",
		Role: RoleViewer, IdempotencyKey: uuid.NewString(),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if op.Request.Scope != ScopeNone {
		t.Fatal("omitted operation range did not default to none")
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, op.PlannedIdentityID); err != nil {
		t.Fatal(err)
	}
	person, err := store.UserAssignment(ctx, op.PlannedIdentityID, in.OrganizationID)
	if err != nil || person.Role != RoleViewer || person.Scope != ScopeNone || len(person.VehicleIDs) != 0 {
		t.Fatalf("unassigned persisted role was lost: %+v %v", person, err)
	}
	vehicle, err := store.RegisterVehicle(ctx, in.UserID, in.OrganizationID, in.Issuer, "future-car", "Future car", "future-subject")
	if err != nil {
		t.Fatal(err)
	}
	allowed, err := store.Enforce(ctx, person.UserID, in.OrganizationID, vehicle.VehicleID, ActionCameraLiveView)
	if err != nil || !allowed {
		t.Fatal("default member baseline did not include a newly registered vehicle")
	}
	assignment := Assignment{ActorUserID: in.UserID, UserID: person.UserID, OrganizationID: in.OrganizationID,
		Role: RoleViewer, Scope: ScopeSelected, VehicleIDs: []string{vehicle.VehicleID}}
	if _, err := store.AssignManagedRole(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	if allowed, err := store.Enforce(ctx, person.UserID, in.OrganizationID, vehicle.VehicleID, ActionCameraLiveView); err != nil || !allowed {
		t.Fatal("subsequent explicit assignment did not grant access")
	}
	assignment.Scope, assignment.VehicleIDs = ScopeNone, nil
	if _, err := store.AssignManagedRole(ctx, assignment); err != nil {
		t.Fatal(err)
	}
	if allowed, err := store.Enforce(ctx, person.UserID, in.OrganizationID, vehicle.VehicleID, ActionCameraLiveView); err != nil || !allowed {
		t.Fatal("returning to no operation range removed member read baseline")
	}
	for _, action := range []string{ActionRemoteControl, ActionTaskManage} {
		if allowed, err := store.Enforce(ctx, person.UserID, in.OrganizationID, vehicle.VehicleID, action); err != nil || allowed {
			t.Fatalf("default member received execution action %s: %v %v", action, allowed, err)
		}
	}
}

func TestPostgresGeneratedVehicleIDIsStableForIdempotentPlan(t *testing.T) {
	store, _ := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	request := OnboardingRequest{Kind: "vehicle", Name: "Numbered car",
		VehicleNumber: "Truck-001", IdempotencyKey: uuid.NewString()}
	first, err := store.CreateOnboarding(context.Background(), in.UserID, in.OrganizationID, request, bytes.Repeat([]byte{1}, 71))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateOnboarding(context.Background(), in.UserID, in.OrganizationID, request, bytes.Repeat([]byte{2}, 71))
	if err != nil || second.VehicleID != first.VehicleID {
		t.Fatal("idempotent vehicle retry generated a different identity")
	}
	request.IdempotencyKey = uuid.NewString()
	if _, err := store.CreateOnboarding(context.Background(), in.UserID, in.OrganizationID, request, bytes.Repeat([]byte{3}, 71)); !errors.Is(err, ErrConflict) {
		t.Fatal("same customer-local number was registered twice")
	}
	other := BootstrapInput{OrganizationID: uuid.NewString(), OrganizationName: "Another customer",
		UserID: uuid.NewString(), Name: "Other admin", Issuer: in.Issuer, Subject: "other-customer"}
	if err := store.Bootstrap(context.Background(), other); err != nil {
		t.Fatal(err)
	}
	another, err := store.CreateOnboarding(context.Background(), other.UserID, other.OrganizationID, request, bytes.Repeat([]byte{3}, 71))
	if err != nil || another.VehicleID == first.VehicleID {
		t.Fatal("different customers could not use the same local vehicle number")
	}
}

func TestPostgresOnboardingRoleBoundaryAndAuthorizationRecheck(t *testing.T) {
	store, db := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	admin, err := store.RegisterPerson(ctx, in.UserID, in.OrganizationID, in.Issuer, "Organization admin", "org-admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: admin.UserID, OrganizationID: in.OrganizationID, Role: RoleOrgAdmin, Scope: ScopeAll}); err != nil {
		t.Fatal(err)
	}
	request := OnboardingRequest{Kind: "person", Name: "New viewer", Email: "viewer@example.test", Role: RoleOrgAdmin, Scope: ScopeAll, IdempotencyKey: uuid.NewString()}
	if _, err := store.CreateOnboarding(ctx, admin.UserID, in.OrganizationID, request, nil); !errors.Is(err, ErrIdentityBindingRestricted) {
		t.Fatalf("org admin created admin: %v", err)
	}
	request.Role = RoleViewer
	op, err := store.CreateOnboarding(ctx, admin.UserID, in.OrganizationID, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE authz_organization_memberships SET status='removed' WHERE user_id=$1 AND org_id=$2`, admin.UserID, in.OrganizationID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, op.PlannedIdentityID); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("stale authorization bound identity: %v", err)
	}
	if _, err := store.ResolveUser(ctx, in.Issuer, op.PlannedIdentityID); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("rejected binding left identity: %v", err)
	}
	// A provider-owned UUID colliding with an existing user must not add
	// memberships or overwrite an existing principal.
	request.Email, request.IdempotencyKey = "collision@example.test", uuid.NewString()
	collision, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO authz_users(user_id,status,name) VALUES($1,'active','Unrelated')`, collision.PlannedIdentityID); err != nil {
		t.Fatal(err)
	}
	if err := store.StartOnboarding(ctx, collision.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, collision, in.Issuer, collision.PlannedIdentityID); !errors.Is(err, ErrConflict) {
		t.Fatalf("existing user adopted: %v", err)
	}
}

func TestPostgresOnboardingInstallationTicketsAndMachineAudience(t *testing.T) {
	store, db := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	ciphertext := bytes.Repeat([]byte{0x9a}, 71)
	request := OnboardingRequest{Kind: "vehicle", Name: "Fresh car", VehicleID: "onboard-car", IdempotencyKey: uuid.NewString()}
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	subject := "admin/" + op.ProviderName
	if err := store.BindOnboarding(ctx, op, in.Issuer, subject); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		audiences []string
		want      bool
	}{{[]string{"wrong"}, false}, {[]string{op.ClientID}, true}, {nil, false}} {
		got, err := store.MachineAudienceAllowed(ctx, in.Issuer, subject, test.audiences)
		if err != nil || got != test.want {
			t.Fatalf("audience check = %v %v", got, err)
		}
	}
	request.IdempotencyKey = uuid.NewString()
	if _, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, ciphertext); !errors.Is(err, ErrConflict) {
		t.Fatalf("existing vehicle accepted: %v", err)
	}
	hash := sha256.Sum256([]byte("disposable-ticket-never-a-secret"))
	if err := store.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	consumed, err := store.ConsumeInstallationTicket(ctx, hash)
	if err != nil || !bytes.Equal(consumed.CredentialCiphertext, ciphertext) {
		t.Fatalf("consume ciphertext=%v err=%v", bytes.Equal(consumed.CredentialCiphertext, ciphertext), err)
	}
	if _, err := store.ConsumeInstallationTicket(ctx, hash); !errors.Is(err, ErrInstallationTicket) {
		t.Fatalf("ticket replay = %v", err)
	}
	expired := sha256.Sum256([]byte("expired-ticket"))
	if err := store.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, expired, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE authz_installation_tickets SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, expired[:]); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInstallationTicket(ctx, expired); !errors.Is(err, ErrInstallationTicket) {
		t.Fatalf("expired ticket = %v", err)
	}
	if err := store.CompleteInstallation(ctx, in.Issuer, op.VehicleID); err != nil {
		t.Fatal(err)
	}
	complete, err := store.GetOnboarding(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || complete.Status != "completed" || complete.CredentialCiphertext != nil {
		t.Fatalf("installation completion = %+v %v", complete, err)
	}
	if _, err := store.PrepareInstallationRotation(ctx, in.UserID, in.OrganizationID, op.ID, ciphertext); !errors.Is(err, ErrConflict) {
		t.Fatalf("completed identity rotated by onboarding: %v", err)
	}
	if _, err := db.Exec(`UPDATE authz_organizations SET status='suspended' WHERE org_id=$1`, in.OrganizationID); err != nil {
		t.Fatal(err)
	}
	if allowed, err := store.MachineAudienceAllowed(ctx, in.Issuer, subject, []string{op.ClientID}); err != nil || allowed {
		t.Fatalf("inactive org audience=%v err=%v", allowed, err)
	}
}

func TestPostgresOnboardingRotationRevokesWithoutFalseConsumption(t *testing.T) {
	store, _ := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	ciphertext := bytes.Repeat([]byte{0x6a}, 71)
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, OnboardingRequest{Kind: "vehicle", Name: "Rotate car", VehicleID: "rotate-car", IdempotencyKey: uuid.NewString()}, ciphertext)
	if err != nil {
		t.Fatal(err)
	}

	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, in.Issuer, "admin/"+op.ProviderName); err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte("unconsumed-original"))
	if err := store.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PrepareInstallationRotation(ctx, in.UserID, in.OrganizationID, op.ID, bytes.Repeat([]byte{0x6b}, 71)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeInstallationTicket(ctx, hash); !errors.Is(err, ErrInstallationTicket) {
		t.Fatalf("rotation kept old ticket active: %v", err)
	}
	if err := store.CompleteInstallation(ctx, in.Issuer, op.VehicleID); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("revocation counted as actual redemption: %v", err)
	}
}

func TestPostgresOnboardingPersistentBoundedRetry(t *testing.T) {
	store, db := managementTestStore(t)
	in := onboardingBootstrap(t, store)
	ctx := context.Background()
	op, err := store.CreateOnboarding(ctx, in.UserID, in.OrganizationID, OnboardingRequest{Kind: "person", Name: "Retry person", Email: "retry@example.test",
		Role: RoleViewer, Scope: ScopeAll, IdempotencyKey: uuid.NewString()}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Reconstructing the Store, as on Gateway restart, preserves the immutable
	// provider plan rather than allocating a new identity.
	restarted, err := NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	next, err := restarted.NextOnboarding(ctx)
	if err != nil || next.ID != op.ID || next.PlannedIdentityID != op.PlannedIdentityID {
		t.Fatalf("recovered plan = %+v err=%v", next, err)
	}
	for i := 0; i < 3; i++ {
		if err := restarted.StartOnboarding(ctx, op.ID); err != nil {
			t.Fatal(err)
		}
		if err := restarted.FailOnboarding(ctx, op.ID, "PROVIDER_UNAVAILABLE"); err != nil {
			t.Fatal(err)
		}
	}
	failed, err := restarted.GetOnboarding(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || failed.Status != "failed" || failed.Attempts != 3 || failed.ErrorCode != "PROVIDER_UNAVAILABLE" {
		t.Fatalf("bounded failure = %+v err=%v", failed, err)
	}
	if err := restarted.StartOnboarding(ctx, op.ID); !errors.Is(err, ErrConflict) {
		t.Fatalf("exhausted operation started: %v", err)
	}
	retried, err := restarted.RetryOnboarding(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || retried.Status != "pending" || retried.PlannedIdentityID != op.PlannedIdentityID || retried.Attempts != 0 {
		t.Fatalf("explicit immutable retry = %+v err=%v", retried, err)
	}
	if err := restarted.FailOnboarding(ctx, op.ID, "provider secret or arbitrary unsafe detail"); !errors.Is(err, ErrInvalidRegistration) {
		t.Fatalf("unsafe provider detail persisted: %v", err)
	}
}
