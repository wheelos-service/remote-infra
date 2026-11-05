package authorization

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func lifecycleFixture(t *testing.T) (*Store, BootstrapInput, Person) {
	t.Helper()
	store, _ := managementTestStore(t)
	in := BootstrapInput{OrganizationID: uuid.NewString(), OrganizationName: "Lifecycle fleet", UserID: uuid.NewString(), Name: "Platform", Issuer: "https://fixture.example", Subject: uuid.NewString()}
	if err := store.Bootstrap(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	person, err := store.RegisterPerson(context.Background(), in.UserID, in.OrganizationID, in.Issuer, "Member", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return store, in, person
}
func lifecycleInput(t *testing.T, s *Store) LifecycleRequest {
	t.Helper()
	version, err := s.Version(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return LifecycleRequest{IdempotencyKey: uuid.NewString(), ExpectedVersion: version, Reason: "Fixture access review"}
}
func TestLifecycleMembershipIdempotencyAndRejoin(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	v, err := s.RegisterVehicle(ctx, in.UserID, in.OrganizationID, in.Issuer, "life-car", "Vehicle", "life-device")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleRemoteOperator, Scope: ScopeAll}); err != nil {
		t.Fatal(err)
	}
	request := lifecycleInput(t, s)
	op, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", request, false)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", request, false)
	if err != nil || repeated.ID != op.ID {
		t.Fatalf("retry: %+v %v", repeated, err)
	}
	request.Reason = "Changed request"
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", request, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("key collision: %v", err)
	}
	if allowed, err := s.Enforce(ctx, p.UserID, in.OrganizationID, v.VehicleID, ActionCameraLiveView); err != nil || allowed {
		t.Fatalf("removed viewer: %v %v", allowed, err)
	}
	if _, err := s.ResolveUser(ctx, in.Issuer, p.Subject); err != nil {
		t.Fatalf("global identity removed: %v", err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_rejoin", lifecycleInput(t, s), false); err != nil {
		t.Fatal(err)
	}
	assignment, err := s.UserAssignment(ctx, p.UserID, in.OrganizationID)
	if err != nil || assignment.Scope != ScopeNone || assignment.Role != RoleViewer {
		t.Fatalf("rejoin restored authority: %+v %v", assignment, err)
	}
	if allowed, err := s.Enforce(ctx, p.UserID, in.OrganizationID, v.VehicleID, ActionRemoteControl); err != nil || allowed {
		t.Fatalf("rejoin control: %v %v", allowed, err)
	}
	if allowed, err := s.Enforce(ctx, p.UserID, in.OrganizationID, v.VehicleID, ActionCameraLiveView); err != nil || !allowed {
		t.Fatalf("rejoin observation: %v %v", allowed, err)
	}
}
func TestLifecycleVehicleRemovalRevocationAndRecovery(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	v, err := s.RegisterVehicle(ctx, in.UserID, in.OrganizationID, in.Issuer, "life-car", "Vehicle", "life-device")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleRemoteOperator, Scope: ScopeSelected, VehicleIDs: []string{v.VehicleID}}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle_remove", lifecycleInput(t, s), false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, v.Subject); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("disabled identity: %v", err)
	}
	request := lifecycleInput(t, s)
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle_reactivate", request, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("unverified reactivation: %v", err)
	}
	request.VerifiedSubject = v.Subject
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle_reactivate", request, false); err != nil {
		t.Fatal(err)
	}
	if allowed, err := s.Enforce(ctx, p.UserID, in.OrganizationID, v.VehicleID, ActionRemoteControl); err != nil || allowed {
		t.Fatalf("selected grant resurrected: %v %v", allowed, err)
	}
	op, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "credential_revoke", lifecycleInput(t, s), false)
	if err != nil || op.ProviderStatus != "manual_required" {
		t.Fatalf("revoke: %+v %v", op, err)
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, v.Subject); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("revoked identity: %v", err)
	}
	if err := s.ReconcileLifecycle(ctx, in.UserID, in.OrganizationID, op.ID, "confirm", "Verified provider credential disabled externally"); err != nil {
		t.Fatal(err)
	}
	stored, err := s.GetLifecycle(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || stored.ProviderStatus != "confirmed" {
		t.Fatalf("confirmation: %+v %v", stored, err)
	}
	request = lifecycleInput(t, s)
	request.VerifiedSubject = v.Subject
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle_reactivate", request, false); !errors.Is(err, ErrConflict) {
		t.Fatalf("revoked reactivation: %v", err)
	}
}
func TestLifecycleReadIsolationAuditAndMigration(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	if err := s.Migrate(ctx); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", lifecycleInput(t, s), false); err != nil {
		t.Fatal(err)
	}
	registration, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || registration.Status != "removed" {
		t.Fatalf("registration: %+v %v", registration, err)
	}
	if _, err := s.Registration(ctx, p.UserID, in.OrganizationID, p.UserID, "person"); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("unauthorized diagnostic: %v", err)
	}
	first, err := s.Audit(ctx, in.UserID, in.OrganizationID, AuditFilter{Limit: 1})
	if err != nil || len(first.Items) != 1 || first.NextCursor == "" {
		t.Fatalf("audit first: %+v %v", first, err)
	}
	next, err := s.Audit(ctx, in.UserID, in.OrganizationID, AuditFilter{Limit: 1, Cursor: first.NextCursor})
	if err != nil || len(next.Items) != 1 || next.Items[0].ID == first.Items[0].ID {
		t.Fatalf("audit next: %+v %v", next, err)
	}
	if _, err := s.Audit(ctx, in.UserID, in.OrganizationID, AuditFilter{Cursor: first.NextCursor, Action: "different"}); !errors.Is(err, ErrInvalidRegistration) {
		t.Fatalf("cursor filter reuse: %v", err)
	}
	for _, f := range []AuditFilter{{Limit: 101}, {Cursor: "malformed"}, {Actor: "invalid"}, {Outcome: "invented"}} {
		if _, err := s.Audit(ctx, in.UserID, in.OrganizationID, f); !errors.Is(err, ErrInvalidRegistration) {
			t.Fatalf("invalid filter: %v", err)
		}
	}
	if _, err := s.Audit(ctx, p.UserID, in.OrganizationID, AuditFilter{}); !errors.Is(err, ErrNotOrganizationAdmin) {
		t.Fatalf("unauthorized audit: %v", err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, uuid.NewString(), p.UserID, "member_remove", lifecycleInput(t, s), false); err == nil {
		t.Fatal("foreign organization mutation accepted")
	}
}
func TestLifecycleStaleAssignmentsAndLastAdmin(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	if _, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleOrgAdmin, Scope: ScopeAll}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM casbin_rule WHERE (ptype='g' AND v0=$1) OR (ptype='p' AND v2='role:org_admin' AND v1 IN (SELECT v1 FROM casbin_rule WHERE ptype='g' AND v0=$1))`, "user:"+in.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE authz_authorization_state SET version=version+1`); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lifecycle(ctx, p.UserID, in.OrganizationID, p.UserID, "member_remove", lifecycleInput(t, s), false); !errors.Is(err, ErrLastOrganizationAdmin) {
		t.Fatalf("last admin removal: %v", err)
	}
	stale := int64(0)
	if _, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleViewer, Scope: ScopeNone, ExpectedVersion: &stale}); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale assignment: %v", err)
	}
}

func TestLifecycleCancellationAndDurableRevocation(t *testing.T) {
	s, in, _ := lifecycleFixture(t)
	ctx := context.Background()
	request := OnboardingRequest{Kind: "vehicle", Name: "Auto", VehicleID: "auto-life", IdempotencyKey: uuid.NewString()}
	op, err := s.CreateOnboarding(ctx, in.UserID, in.OrganizationID, request, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.BindOnboarding(ctx, op, in.Issuer, "admin/"+op.ProviderName); err != nil {
		t.Fatal(err)
	}
	revoked, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, op.VehicleID, "credential_revoke", lifecycleInput(t, s), true)
	if err != nil || revoked.ProviderStatus != "pending" {
		t.Fatalf("revoke: %+v %v", revoked, err)
	}
	if err := s.CompleteInstallation(ctx, in.Issuer, op.VehicleID); err == nil {
		t.Fatal("late completion accepted")
	}
	if _, err := s.PrepareInstallationRotation(ctx, in.UserID, in.OrganizationID, op.ID, make([]byte, 32)); err == nil {
		t.Fatal("cancelled rotation accepted")
	}
	if _, err := s.RetryOnboarding(ctx, in.UserID, in.OrganizationID, op.ID); err == nil {
		t.Fatal("cancelled onboarding retry accepted")
	}
	work, err := s.NextRevocation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		work.Attempts = attempt
		if err := s.RecordRevocation(ctx, work, "PROVIDER_UNAVAILABLE"); err != nil {
			t.Fatal(err)
		}
	}
	state, err := s.GetLifecycle(ctx, in.UserID, in.OrganizationID, revoked.ID)
	if err != nil || state.ProviderStatus != "failed" {
		t.Fatalf("failure persisted: %+v %v", state, err)
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, "admin/"+op.ProviderName); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("provider failure restored identity: %v", err)
	}
	if err := s.ReconcileLifecycle(ctx, in.UserID, in.OrganizationID, revoked.ID, "retry", "Provider recovered"); err != nil {
		t.Fatal(err)
	}
	work, err = s.NextRevocation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRevocation(ctx, work, ""); err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRevocation(ctx, work, ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("stale worker accepted: %v", err)
	}
	state, err = s.GetLifecycle(ctx, in.UserID, in.OrganizationID, revoked.ID)
	if err != nil || state.ProviderStatus != "confirmed" {
		t.Fatalf("confirmation: %+v %v", state, err)
	}
}

func TestInstalledDeviceRotationFencesOldIdentityAndTickets(t *testing.T) {
	s, in, _ := lifecycleFixture(t)
	ctx := context.Background()
	original, err := s.CreateOnboarding(ctx, in.UserID, in.OrganizationID, OnboardingRequest{Kind: "vehicle", Name: "Replace", VehicleID: "replace-car", IdempotencyKey: uuid.NewString()}, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StartOnboarding(ctx, original.ID); err != nil {
		t.Fatal(err)
	}
	oldSubject := "admin/" + original.ProviderName
	if err := s.BindOnboarding(ctx, original, in.Issuer, oldSubject); err != nil {
		t.Fatal(err)
	}
	originalTicket := sha256.Sum256([]byte("original-install"))
	if err := s.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, original.ID, originalTicket, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumeInstallationTicket(ctx, originalTicket); err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteInstallation(ctx, in.Issuer, original.VehicleID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "credential_revoke", lifecycleInput(t, s), true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "credential_rotate", lifecycleInput(t, s), true, make([]byte, 32)); err == nil {
		t.Fatal("replacement accepted before revocation confirmation")
	}
	revocation, err := s.NextRevocation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRevocation(ctx, revocation, ""); err != nil {
		t.Fatal(err)
	}
	request := lifecycleInput(t, s)
	op, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "credential_rotate", request, true, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "credential_rotate", lifecycleInput(t, s), true, make([]byte, 32)); err == nil {
		t.Fatal("competing replacement accepted")
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, oldSubject); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("old identity remains: %v", err)
	}
	work, err := s.NextRevocation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.RecordRevocation(ctx, work, ""); err != nil {
		t.Fatal(err)
	}
	rotation, err := s.NextRotation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 3; attempt++ {
		rotation.Attempts = attempt
		if err := s.StartRotation(ctx, rotation); err != nil {
			t.Fatal(err)
		}
		if err := s.StartRotation(ctx, rotation); !errors.Is(err, ErrConflict) {
			t.Fatalf("duplicate provider attempt accepted: %v", err)
		}
		if err := s.FailRotation(ctx, rotation, "PROVIDER_UNAVAILABLE"); err != nil {
			t.Fatal(err)
		}
	}
	restarted, err := NewStore(s.db)
	if err != nil {
		t.Fatal(err)
	}
	failed, err := restarted.Rotation(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || failed.Status != "failed" || failed.Attempts != 3 {
		t.Fatalf("replacement exhaustion not durable: status=%s attempts=%d err=%v", failed.Status, failed.Attempts, err)
	}
	if err := s.ReconcileLifecycle(ctx, in.UserID, in.OrganizationID, op.ID, "retry", "Provider recovered"); err != nil {
		t.Fatal(err)
	}
	rotation, err = s.NextRotation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.BindRotation(ctx, rotation, in.Issuer); err != nil {
		t.Fatal(err)
	}
	newSubject := "admin/" + rotation.Operation.ProviderName
	if _, err := s.ResolveVehicle(ctx, in.Issuer, newSubject); !errors.Is(err, ErrUnknownIdentity) {
		t.Fatalf("pending identity has normal authority: %v", err)
	}
	installing, err := s.ResolveInstallingVehicle(ctx, in.Issuer, newSubject)
	if err != nil || installing.VehicleID != original.VehicleID {
		t.Fatalf("installation identity: %+v %v", installing, err)
	}
	if allowed, err := s.MachineAudienceAllowed(ctx, in.Issuer, newSubject, []string{original.ClientID}); err != nil || allowed {
		t.Fatal("old audience accepted")
	}
	if allowed, err := s.MachineAudienceAllowed(ctx, in.Issuer, newSubject, []string{rotation.Operation.ClientID}); err != nil || !allowed {
		t.Fatalf("replacement audience: %v %v", allowed, err)
	}
	if err := s.CompleteRotation(ctx, in.Issuer, original.VehicleID, newSubject, rotation.Operation.ClientID); err == nil {
		t.Fatal("activation before ticket consumption")
	}
	hash := sha256.Sum256([]byte("fixture-replacement"))
	if err := s.CreateRotationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if org, err := s.InstallationTicketOrganization(ctx, hash); err != nil || org != in.OrganizationID {
		t.Fatalf("rotation ticket organization: %s %v", org, err)
	}
	if _, err := s.ConsumeInstallationTicket(ctx, hash); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ConsumeInstallationTicket(ctx, hash); !errors.Is(err, ErrInstallationTicket) {
		t.Fatalf("ticket replay: %v", err)
	}
	if _, err := s.PrepareRotationTicket(ctx, in.UserID, in.OrganizationID, op.ID, make([]byte, 32)); err == nil {
		t.Fatal("consumed replacement identity reissued")
	}
	if err := s.CompleteRotation(ctx, in.Issuer, original.VehicleID, newSubject, rotation.Operation.ClientID); err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteRotation(ctx, in.Issuer, original.VehicleID, newSubject, rotation.Operation.ClientID); err != nil {
		t.Fatalf("completion retry: %v", err)
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, newSubject); err != nil {
		t.Fatal(err)
	}
	result, err := s.Rotation(ctx, in.UserID, in.OrganizationID, op.ID)
	if err != nil || result.Status != "completed" || len(result.Operation.CredentialCiphertext) != 0 {
		t.Fatalf("completion cleanup: %+v %v", result, err)
	}
	if _, err := s.PrepareRotationTicket(ctx, in.UserID, in.OrganizationID, op.ID, make([]byte, 32)); err == nil {
		t.Fatal("completed rotation reopened")
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "vehicle_remove", lifecycleInput(t, s), true); err != nil {
		t.Fatal(err)
	}
	reactivate := lifecycleInput(t, s)
	reactivate.VerifiedSubject = newSubject
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "vehicle_reactivate", reactivate, true); err != nil {
		t.Fatalf("historical revocation blocked verified replacement rejoin: %v", err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, original.VehicleID, "credential_rotate", lifecycleInput(t, s), true, make([]byte, 32)); err != nil {
		t.Fatalf("second generation rotation: %v", err)
	}
	if err := s.CompleteRotation(ctx, in.Issuer, original.VehicleID, newSubject, rotation.Operation.ClientID); err == nil {
		t.Fatal("prior generation completion accepted")
	}
}

func TestVehicleTransferAndAuthenticatedObservation(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	other := BootstrapInput{OrganizationID: uuid.NewString(), OrganizationName: "Destination", UserID: uuid.NewString(), Name: "Destination operator", Issuer: in.Issuer, Subject: uuid.NewString()}
	if err := s.Bootstrap(ctx, other); err != nil {
		t.Fatal(err)
	}
	v, err := s.RegisterVehicle(ctx, in.UserID, in.OrganizationID, in.Issuer, "transfer-car", "Transfer", "transfer-subject")
	if err != nil {
		t.Fatal(err)
	}
	request := lifecycleInput(t, s)
	request.DestinationOrganizationID = other.OrganizationID
	request.VerifiedSubject = v.Subject
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle_transfer", request, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Registration(ctx, in.UserID, in.OrganizationID, v.VehicleID, "vehicle"); !errors.Is(err, ErrInactiveLifecycle) {
		t.Fatalf("source retained resource: %v", err)
	}
	destination, err := s.Registration(ctx, other.UserID, other.OrganizationID, v.VehicleID, "vehicle")
	if err != nil || destination.Status != "disabled" {
		t.Fatalf("destination: %+v %v", destination, err)
	}
	request = lifecycleInput(t, s)
	request.VerifiedSubject = v.Subject
	if _, err := s.Lifecycle(ctx, other.UserID, other.OrganizationID, v.VehicleID, "vehicle_reactivate", request, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ResolveVehicle(ctx, in.Issuer, v.Subject); err != nil {
		t.Fatal(err)
	}
	before, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || before.FirstAuthenticatedAt != nil {
		t.Fatal("invitation implies authenticated observation")
	}
	if err := s.RecordAuthenticatedUser(ctx, p.UserID); err != nil {
		t.Fatal(err)
	}
	observed, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || observed.FirstAuthenticatedAt == nil {
		t.Fatal("authenticated observation missing")
	}
	if err := s.RecordAuthenticatedUser(ctx, p.UserID); err != nil {
		t.Fatal(err)
	}
	repeated, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || !repeated.FirstAuthenticatedAt.Equal(*observed.FirstAuthenticatedAt) {
		t.Fatal("first observation overwritten")
	}
}

func TestLifecycleConcurrentAssignmentCannotResurrectRemovedMember(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	request := lifecycleInput(t, s)
	outcomes := make(chan error, 2)
	start := make(chan struct{})
	go func() {
		<-start
		_, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", request, false)
		outcomes <- err
	}()
	go func() {
		<-start
		_, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleRemoteOperator, Scope: ScopeAll, ExpectedVersion: &request.ExpectedVersion})
		outcomes <- err
	}()
	close(start)
	failures := 0
	for i := 0; i < 2; i++ {
		if <-outcomes != nil {
			failures++
		}
	}
	if failures != 1 {
		t.Fatalf("competing same-version writers: %d failures", failures)
	}
	state, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil {
		t.Fatal(err)
	}
	if state.Status == "active" {
		if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", lifecycleInput(t, s), false); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AssignManagedRole(ctx, Assignment{ActorUserID: in.UserID, UserID: p.UserID, OrganizationID: in.OrganizationID, Role: RoleRemoteOperator, Scope: ScopeAll, ExpectedVersion: &request.ExpectedVersion}); err == nil {
		t.Fatal("stale writer resurrected membership")
	}
	restarted, err := NewStore(s.db)
	if err != nil {
		t.Fatal(err)
	}
	if err := restarted.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	state, err = restarted.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || state.Status != "removed" {
		t.Fatal("restart lost removal")
	}
}

func TestLifecycleUpgradeAndFailedMigrationRollback(t *testing.T) {
	s, in, p := lifecycleFixture(t)
	ctx := context.Background()
	if _, err := s.db.ExecContext(ctx, `DROP TABLE authz_rotation_tickets,authz_device_rotations,authz_lifecycle_operations; ALTER TABLE authz_onboarding_operations DROP COLUMN cancelled_at; ALTER TABLE authz_users DROP COLUMN first_authenticated_at; CREATE TABLE authz_lifecycle_operations(dummy text)`); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err == nil {
		t.Fatal("malformed predecessor schema accepted")
	}
	var column bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='authz_onboarding_operations' AND column_name='cancelled_at')`).Scan(&column); err != nil || column {
		t.Fatalf("failed migration partially committed: %v %v", column, err)
	}
	if _, err := s.db.ExecContext(ctx, `DROP TABLE authz_lifecycle_operations`); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	if id, err := s.ResolveUser(ctx, in.Issuer, p.Subject); err != nil || id != p.UserID {
		t.Fatalf("upgrade lost identity: %s %v", id, err)
	}
	if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, p.UserID, "member_remove", lifecycleInput(t, s), false); err != nil {
		t.Fatal(err)
	}
	if err := s.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	registration, err := s.Registration(ctx, in.UserID, in.OrganizationID, p.UserID, "person")
	if err != nil || registration.Status != "removed" {
		t.Fatal("repeated migration restored membership")
	}
}

func TestLifecycleConcurrentInstallationCannotRestoreRemovedVehicle(t *testing.T) {
	for _, stage := range []string{"bind", "ticket", "redeem", "complete"} {
		t.Run(stage, func(t *testing.T) {
			s, in, _ := lifecycleFixture(t)
			ctx := context.Background()
			op, err := s.CreateOnboarding(ctx, in.UserID, in.OrganizationID, OnboardingRequest{Kind: "vehicle", VehicleID: "racing-car", Name: "Racing", IdempotencyKey: uuid.NewString()}, make([]byte, 32))
			if err != nil {
				t.Fatal(err)
			}
			if err := s.StartOnboarding(ctx, op.ID); err != nil {
				t.Fatal(err)
			}
			subject := "admin/" + op.ProviderName
			if err := s.BindOnboarding(ctx, op, in.Issuer, subject); err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256([]byte("racing-ticket"))
			if stage == "redeem" || stage == "complete" {
				if err := s.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute)); err != nil {
					t.Fatal(err)
				}
			}
			if stage == "complete" {
				if _, err := s.ConsumeInstallationTicket(ctx, hash); err != nil {
					t.Fatal(err)
				}
			}
			request := lifecycleInput(t, s)
			start := make(chan struct{})
			removed, advanced := make(chan error, 1), make(chan error, 1)
			go func() {
				<-start
				_, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, op.VehicleID, "vehicle_remove", request, true)
				removed <- err
			}()
			advance := func() error {
				switch stage {
				case "bind":
					return s.BindOnboarding(ctx, op, in.Issuer, subject)
				case "ticket":
					return s.CreateInstallationTicket(ctx, in.UserID, in.OrganizationID, op.ID, hash, time.Now().Add(time.Minute))
				case "redeem":
					_, err := s.ConsumeInstallationTicket(ctx, hash)
					return err
				default:
					return s.CompleteInstallation(ctx, in.Issuer, op.VehicleID)
				}
			}
			go func() { <-start; advanced <- advance() }()
			close(start)
			removeErr, advanceErr := mutationError(<-removed), mutationError(<-advanced)
			if advanceErr != nil && !errors.Is(advanceErr, ErrConflict) && !errors.Is(advanceErr, ErrInstallationTicket) && !errors.Is(advanceErr, ErrUnknownIdentity) {
				t.Fatalf("unexpected concurrent result: %v", advanceErr)
			}
			if removeErr != nil {
				if !errors.Is(removeErr, ErrConflict) {
					t.Fatal(removeErr)
				}
				if _, err := s.Lifecycle(ctx, in.UserID, in.OrganizationID, op.VehicleID, "vehicle_remove", lifecycleInput(t, s), true); err != nil {
					t.Fatal(err)
				}
			}
			if err := advance(); err == nil {
				t.Fatal("late installation work succeeded after removal")
			}
			if _, err := s.ResolveVehicle(ctx, in.Issuer, subject); !errors.Is(err, ErrUnknownIdentity) {
				t.Fatalf("removed vehicle regained authority: %v", err)
			}
			current, err := s.GetOnboarding(ctx, in.UserID, in.OrganizationID, op.ID)
			if err != nil || current.Status != "cancelled" || len(current.CredentialCiphertext) != 0 {
				t.Fatalf("cancellation not durable: status=%s err=%v", current.Status, err)
			}
		})
	}
}
