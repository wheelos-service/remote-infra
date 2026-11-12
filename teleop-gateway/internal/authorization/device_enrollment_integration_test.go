package authorization

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestPostgresDeviceEnrollmentAtomicApprovalAndIdentityRecovery(t *testing.T) {
	store, db := managementTestStore(t)
	bootstrap := onboardingBootstrap(t, store)
	ctx := context.Background()
	key, _, _ := ed25519.GenerateKey(rand.Reader)
	e := DeviceEnrollment{ID: uuid.NewString(), Name: "Test vehicle", Serial: "SN-test", Platform: "test",
		PublicKey: key, UserCode: "ABC23456", DeviceCodeHash: bytes.Repeat([]byte{1}, 32), DeviceCodeCiphertext: bytes.Repeat([]byte{2}, 71)}
	var err error
	e, err = store.CreateDeviceEnrollment(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	input := OnboardingRequest{Kind: "vehicle", Name: "Test vehicle", VehicleNumber: "test-001", IdempotencyKey: e.ID}
	ciphertext := bytes.Repeat([]byte{3}, 71)
	// Force approval failure after reserving the operation: both must roll back.
	if _, err := db.Exec(`CREATE FUNCTION reject_enrollment_event() RETURNS trigger LANGUAGE plpgsql AS $body$
		BEGIN IF NEW.event_type='approved' THEN RAISE EXCEPTION 'test approval audit failure'; END IF; RETURN NEW; END $body$;
		CREATE TRIGGER reject_enrollment_event BEFORE INSERT ON authz_device_enrollment_events
		FOR EACH ROW EXECUTE FUNCTION reject_enrollment_event()`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateApprovedDeviceEnrollment(ctx, bootstrap.UserID, bootstrap.OrganizationID, e.ID, input, ciphertext); err == nil {
		t.Fatal("approval succeeded without audit")
	}
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM authz_onboarding_operations WHERE idempotency_key=$1`, e.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("failed approval orphaned a provisioning operation")
	}
	if _, err := db.Exec(`DROP TRIGGER reject_enrollment_event ON authz_device_enrollment_events; DROP FUNCTION reject_enrollment_event()`); err != nil {
		t.Fatal(err)
	}
	e, err = store.CreateApprovedDeviceEnrollment(ctx, bootstrap.UserID, bootstrap.OrganizationID, e.ID, input, ciphertext)
	if err != nil {
		t.Fatal(err)
	}
	op, err := store.GetOnboarding(ctx, bootstrap.UserID, bootstrap.OrganizationID, e.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.BindOnboarding(ctx, op, bootstrap.Issuer, "admin/"+op.ProviderName); err != nil {
		t.Fatal(err)
	}
	ticket := sha256.Sum256([]byte("test-ticket"))
	e.TicketHash, e.TicketExpiresAt = ticket[:], time.Now().Add(time.Minute)
	if err := store.IssueDeviceEnrollmentTicket(ctx, e, ticket[:], ciphertext, e.TicketExpiresAt); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RedeemDeviceEnrollment(ctx, e, ticket[:]); err != nil {
		t.Fatal(err)
	}
	if err := store.CompleteInstallation(ctx, bootstrap.Issuer, op.VehicleID); err != nil {
		t.Fatal(err)
	}
	e.ID, e.UserCode, e.Name = uuid.NewString(), "ABC23457", "Recovery"
	refreshed, err := store.CreateDeviceEnrollment(ctx, e)
	if err != nil || !refreshed.Recovery || refreshed.OperationID != op.ID {
		t.Fatal("new code recreated the vehicle operation")
	}
	rotated, err := store.PrepareDeviceEnrollmentRecovery(ctx, bootstrap.UserID, bootstrap.OrganizationID, op.ID, bytes.Repeat([]byte{4}, 71))
	if err != nil || rotated.VehicleID != op.VehicleID || rotated.ClientID != op.ClientID {
		t.Fatal("credential recovery changed identity")
	}
	if err := store.ClearDeviceEnrollmentRecoveryError(ctx, bootstrap.UserID, bootstrap.OrganizationID, op.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ApproveDeviceEnrollment(ctx, bootstrap.UserID, bootstrap.OrganizationID, refreshed.ID, op.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RedeemDeviceEnrollment(ctx, e, ticket[:]); !errors.Is(err, ErrInstallationTicket) {
		t.Fatal("recovery revived old ticket")
	}
	if _, err := db.Exec(`UPDATE authz_vehicle_identities SET status='revoked' WHERE vehicle_id=$1`, op.VehicleID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.PrepareDeviceEnrollmentRecovery(ctx, bootstrap.UserID, bootstrap.OrganizationID, op.ID, ciphertext); !errors.Is(err, ErrInactiveLifecycle) {
		t.Fatal("recovery reactivated a disabled identity")
	}
}
