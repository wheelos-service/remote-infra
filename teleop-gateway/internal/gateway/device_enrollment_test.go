package gateway

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

func signEnrollment(p enrollmentProof, action string, key ed25519.PrivateKey) enrollmentProof {
	p.Timestamp, p.Nonce = time.Now().Unix(), uuid.NewString()
	p.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(p.message(action))))
	return p
}

func TestDeviceEnrollmentProofBindsEveryFieldAndClock(t *testing.T) {
	public, key, _ := ed25519.GenerateKey(rand.Reader)
	p := signEnrollment(enrollmentProof{RequestID: uuid.NewString(), PublicKey: base64.RawURLEncoding.EncodeToString(public),
		Name: "Test vehicle", Serial: "SN-TEST", Platform: "Orin"}, "create", key)
	if _, ok := p.verify("create", time.Now()); !ok {
		t.Fatal("valid proof rejected")
	}
	for _, mutate := range []func(*enrollmentProof){
		func(p *enrollmentProof) { p.Serial = "OTHER" },
		func(p *enrollmentProof) { p.Nonce = uuid.NewString() },
		func(p *enrollmentProof) { p.Name = "forged\nfield" },
		func(p *enrollmentProof) { p.DeviceCode = strings.Repeat("a", 43) },
		func(p *enrollmentProof) { p.Timestamp -= 121 },
	} {
		other := p
		mutate(&other)
		if _, ok := other.verify("create", time.Now()); ok {
			t.Fatal("tampered proof accepted")
		}
	}
	if _, ok := p.verify("complete", time.Now()); ok {
		t.Fatal("cross-action replay accepted")
	}
}

func TestDeviceEnrollmentProofWithoutMetadataPreservesV1Binding(t *testing.T) {
	public, key, _ := ed25519.GenerateKey(rand.Reader)
	p := signEnrollment(enrollmentProof{RequestID: uuid.NewString(), PublicKey: base64.RawURLEncoding.EncodeToString(public)}, "create", key)
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"name", "serial", "platform"} {
		if _, present := fields[field]; present {
			t.Fatalf("new enrollment unexpectedly contains %s", field)
		}
	}
	if _, valid := p.verify("create", time.Now()); !valid {
		t.Fatal("metadata-free signed enrollment rejected")
	}
	parts := strings.Split(p.message("create"), "\n")
	if len(parts) != 11 || parts[4] != "" || parts[5] != "" || parts[6] != "" {
		t.Fatal("v1 signing format lost its empty metadata slots")
	}
	for _, mutate := range []func(*enrollmentProof){
		func(p *enrollmentProof) { p.Name = "injected" },
		func(p *enrollmentProof) { p.Serial = "injected" },
		func(p *enrollmentProof) { p.Platform = "injected" },
	} {
		other := p
		mutate(&other)
		if _, valid := other.verify("create", time.Now()); valid {
			t.Fatal("unsigned legacy metadata accepted")
		}
	}
}

func TestPostgresDeviceEnrollmentApprovalDeliveryAndCodeRecovery(t *testing.T) {
	f := newManagedFixture(t)
	s := onboardingTestService(t)
	s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
	s.config.GatewayURL, s.config.CasdoorURL = "https://gateway.example.test", managedTestIssuer
	s.Register(f.mux, AuthenticationMiddleware)
	versionReq := httptest.NewRequest(http.MethodGet, "/api/v1/version", nil)
	versionRec := httptest.NewRecorder()
	f.mux.ServeHTTP(versionRec, versionReq)
	if versionRec.Code != http.StatusOK || !strings.Contains(versionRec.Body.String(), `"enrollment_protocol":"teleop-enrollment-v1"`) {
		t.Fatalf("version endpoint failed: status=%d body=%s", versionRec.Code, versionRec.Body.String())
	}
	public, key, _ := ed25519.GenerateKey(rand.Reader)
	p := enrollmentProof{RequestID: uuid.NewString(), PublicKey: base64.RawURLEncoding.EncodeToString(public)}
	call := func(path string, body any, token string, want int) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(body)
		req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(raw))
		req.Header.Set("Accept", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rec := httptest.NewRecorder()
		f.mux.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Fatalf("%s status=%d want=%d code=%s body=%s", path, rec.Code, want, rec.Header().Get("X-Error-Code"), rec.Body.String())
		}
		var result map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	create := signEnrollment(p, "create", key)
	created := call("/api/v1/device-enrollments", create, "", 201)
	code, userCode := created["device_code"].(string), created["user_code"].(string)
	if created["console_url"] != "https://gateway.example.test" {
		t.Fatalf("create did not return configured console_url: %v", created["console_url"])
	}
	retry := call("/api/v1/device-enrollments", signEnrollment(p, "create", key), "", 201)
	if retry["device_code"] != code || retry["user_code"] != userCode || retry["console_url"] != created["console_url"] {
		t.Fatal("lost-create-response retry changed codes")
	}
	call("/api/v1/device-enrollments", create, "", 409)
	adminPath := "/api/admin/organizations/" + f.orgID + "/device-enrollments"
	view := call(adminPath+"/lookup", map[string]string{"user_code": userCode}, "admin", 200)
	if _, leaked := view["device_code"]; leaked || view["fingerprint"] == "" {
		t.Fatal("approval view exposed a secret or omitted fingerprint")
	}
	for _, field := range []string{"name", "serial", "platform"} {
		if _, present := view[field]; present {
			t.Fatalf("approval view exposed retired vehicle metadata: %s", field)
		}
	}
	call(adminPath+"/lookup", map[string]string{"user_code": userCode}, "viewer", 403)
	call(adminPath+"/"+p.RequestID+"/approve", map[string]string{}, "admin", 400)
	fingerprint := view["fingerprint"].(string)
	call(adminPath+"/"+p.RequestID+"/approve", map[string]string{"name": "Test truck"}, "admin", 400)
	call(adminPath+"/"+p.RequestID+"/approve", map[string]string{"name": "Test truck", "expected_fingerprint": "SHA256:" + strings.Repeat("0", 64)}, "admin", 400)
	approvalBody := map[string]string{"name": "Test truck", "expected_fingerprint": fingerprint}
	approved := func() map[string]any {
		// An unrelated provider handshake must not block a fresh approval.
		s.workMu.Lock()
		defer s.workMu.Unlock()
		return call(adminPath+"/"+p.RequestID+"/approve", approvalBody, "admin", 202)
	}()
	opID, vehicle := approved["operation_id"].(string), approved["vehicle_id"].(string)
	if !strings.HasPrefix(vehicle, "v-") {
		t.Fatal("untrusted device name became vehicle ID")
	}
	call(adminPath+"/"+p.RequestID+"/approve", approvalBody, "admin", 202)
	var count int
	if err := f.db.QueryRow(`SELECT count(*) FROM authz_onboarding_operations WHERE operation_id=$1`, opID).Scan(&count); err != nil || count != 1 {
		t.Fatal("approval retry duplicated provisioning")
	}
	ctx := context.Background()
	op, err := f.store.GetOnboarding(ctx, f.adminID, f.orgID, opID)
	if err != nil {
		t.Fatal(err)
	}
	if op.Name != "Test truck" {
		t.Fatal("administrator display name was not saved")
	}
	if op.Request.VehicleNumber != "vehicle-"+strings.ReplaceAll(p.RequestID, "-", "")[:12] {
		t.Fatal("vehicle number was not generated deterministically by the server")
	}
	if err := f.store.StartOnboarding(ctx, op.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.store.BindOnboarding(ctx, op, managedTestIssuer, "admin/"+op.ProviderName); err != nil {
		t.Fatal(err)
	}
	call("/api/admin/organizations/"+f.orgID+"/onboarding/"+op.ID+"/installation-ticket", map[string]string{}, "admin", 409)
	p.DeviceCode, p.Name, p.Serial, p.Platform = code, "", "", ""
	poll := call("/api/v1/device-enrollments/token", signEnrollment(p, "poll", key), "", 200)
	if poll["status"] != "awaiting_install" {
		t.Fatal("verified operation not ready for installation")
	}
	call("/api/v1/device-enrollments/token", signEnrollment(p, "poll", key), "", 429)
	p.Ticket = poll["ticket"].(string)
	call("/api/vehicle/install", map[string]string{}, p.Ticket, 401)
	// Simulate expiry between the client's local check and server redemption.
	if _, err := f.db.Exec(`UPDATE authz_device_enrollments SET ticket_expires_at=now()-interval '1 second',next_poll_at=now() WHERE enrollment_id=$1`, p.RequestID); err != nil {
		t.Fatal(err)
	}
	call("/api/v1/device-enrollments/complete", signEnrollment(p, "complete", key), "", 410)
	expiredTicket := p.Ticket
	p.Ticket = ""
	newTicket := call("/api/v1/device-enrollments/token", signEnrollment(p, "poll", key), "", 200)
	if newTicket["ticket"] == expiredTicket || newTicket["id"] != p.RequestID {
		t.Fatal("ticket expiry did not renew only the ticket on the same approved enrollment")
	}
	p.Ticket = newTicket["ticket"].(string)
	credentials := call("/api/v1/device-enrollments/complete", signEnrollment(p, "complete", key), "", 200)
	second := call("/api/v1/device-enrollments/complete", signEnrollment(p, "complete", key), "", 200)
	if credentials["client_secret"] != second["client_secret"] || credentials["vehicle_id"] != vehicle {
		t.Fatal("lost-response retry rotated credential or changed vehicle")
	}
	tampered := p
	tampered.PublicKey = base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32))
	call("/api/v1/device-enrollments/complete", signEnrollment(tampered, "complete", key), "", 401)
	if err := f.store.CompleteInstallation(ctx, managedTestIssuer, vehicle); err != nil {
		t.Fatal(err)
	}
	call("/api/v1/device-enrollments/complete", signEnrollment(p, "complete", key), "", 404)
	var secret []byte
	if err := f.db.QueryRow(`SELECT credential_ciphertext FROM authz_onboarding_operations WHERE operation_id=$1`, op.ID).Scan(&secret); err != nil || len(secret) != 0 {
		t.Fatal("machine-auth completion retained pending credential")
	}
	// A fresh code retains the already registered key -> vehicle binding and
	// cannot be adopted by another organization, even its administrator.
	p.RequestID, p.DeviceCode, p.Ticket = uuid.NewString(), "", ""
	p.Name, p.Serial, p.Platform = "Recover device", "SN-TEST-1", "Orin"
	refreshed := call("/api/v1/device-enrollments", signEnrollment(p, "create", key), "", 201)
	recovery := call(adminPath+"/lookup", map[string]string{"user_code": refreshed["user_code"].(string)}, "admin", 200)
	if recovery["recovery"] != true || recovery["vehicle_id"] != vehicle || recovery["operation_id"] != op.ID {
		t.Fatal("code refresh lost immutable vehicle binding")
	}
	call("/api/admin/organizations/"+f.otherOrgID+"/device-enrollments/lookup",
		map[string]string{"user_code": refreshed["user_code"].(string)}, "other-admin", 404)
	call(adminPath+"/"+p.RequestID+"/approve", map[string]string{"expected_fingerprint": fingerprint}, "admin", 409)
}

func TestPostgresDeviceEnrollmentDenialExpiryAndNoncePersistence(t *testing.T) {
	f := newManagedFixture(t)
	public, _, _ := ed25519.GenerateKey(rand.Reader)
	e := authorization.DeviceEnrollment{ID: uuid.NewString(), Name: "Test", Serial: "SN", Platform: "Orin",
		PublicKey: public, UserCode: "ABC23456", DeviceCodeHash: bytes.Repeat([]byte{1}, 32), DeviceCodeCiphertext: bytes.Repeat([]byte{2}, 71)}
	ctx := context.Background()
	var err error
	e, err = f.store.CreateDeviceEnrollment(ctx, e)
	if err != nil {
		t.Fatal(err)
	}

	nonce := uuid.NewString()
	if err := f.store.UseEnrollmentNonce(ctx, public, nonce); err != nil {
		t.Fatal(err)
	}
	restarted, _ := authorization.NewStore(f.db)
	if err := restarted.UseEnrollmentNonce(ctx, public, nonce); !errors.Is(err, authorization.ErrEnrollmentReplay) {
		t.Fatal("restart forgot replay protection")
	}
	if _, err := f.store.DenyDeviceEnrollment(ctx, f.adminID, f.orgID, e.ID); err != nil {
		t.Fatal(err)
	}
	polled, err := f.store.DeviceEnrollment(ctx, e.ID, public, e.DeviceCodeHash, false)
	if err != nil || polled.Status != "denied" {
		t.Fatal("denial not preserved")
	}
	// Pending code expiry and a fresh ID preserve the software key.
	e.ID, e.UserCode = uuid.NewString(), "ABC23457"
	e, err = f.store.CreateDeviceEnrollment(ctx, e)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`UPDATE authz_device_enrollments SET expires_at=now()-interval '1 second' WHERE enrollment_id=$1`, e.ID); err != nil {
		t.Fatal(err)
	}
	polled, err = f.store.DeviceEnrollment(ctx, e.ID, public, e.DeviceCodeHash, false)
	if err != nil || polled.Status != "expired" {
		t.Fatal("expired code remained usable")
	}
	e.ID, e.UserCode = uuid.NewString(), "ABC23458"
	fresh, err := f.store.CreateDeviceEnrollment(ctx, e)
	if err != nil || fresh.Status != "pending" || !bytes.Equal(fresh.PublicKey, public) {
		t.Fatal("expiry recovery failed")
	}
}

func TestPostgresDeviceEnrollmentConcurrentFleet(t *testing.T) {
	f := newManagedFixture(t)
	s := onboardingTestService(t)
	s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
	s.Register(f.mux, AuthenticationMiddleware)
	server := httptest.NewServer(f.mux)
	defer server.Close()
	const devices = 100
	type result struct {
		body map[string]any
		err  error
	}
	call := func(path string, proof enrollmentProof, status int) result {
		raw, err := json.Marshal(proof)
		if err != nil {
			return result{err: err}
		}
		client := &http.Client{Timeout: 20 * time.Second}
		response, err := client.Post(server.URL+path, "application/json", bytes.NewReader(raw))
		if err != nil {
			return result{err: fmt.Errorf("fleet request transport failed: %w", err)}
		}
		defer response.Body.Close()
		if response.StatusCode != status {
			return result{err: fmt.Errorf("fleet request status=%d expected=%d code=%s",
				response.StatusCode, status, response.Header.Get("X-Error-Code"))}
		}
		if status == 429 {
			if response.Header.Get("Retry-After") != "5" {
				return result{err: fmt.Errorf("fleet throttling omitted retry guidance")}
			}
			return result{}
		}
		var body map[string]any
		if json.NewDecoder(response.Body).Decode(&body) != nil {
			return result{err: fmt.Errorf("fleet response was not valid JSON")}
		}
		return result{body: body}
	}
	var workers sync.WaitGroup
	for i := 0; i < devices; i++ {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		proof := enrollmentProof{RequestID: uuid.NewString(), PublicKey: base64.RawURLEncoding.EncodeToString(public),
			Name: "Fleet test", Serial: uuid.NewString(), Platform: "test"}
		workers.Add(1)
		go func() {
			defer workers.Done()
			results := make(chan result, 2)
			for retry := 0; retry < 2; retry++ {
				go func() {
					results <- call("/api/v1/device-enrollments", signEnrollment(proof, "create", private), 201)
				}()
			}
			first, second := <-results, <-results
			if first.err != nil || second.err != nil {
				t.Errorf("concurrent fleet creation failed: %v, %v", first.err, second.err)
				return
			}
			if first.body["id"] != proof.RequestID || second.body["id"] != proof.RequestID ||
				first.body["device_code"] != second.body["device_code"] || first.body["user_code"] != second.body["user_code"] {
				t.Error("same-device concurrent retransmission changed the enrollment codes")
				return
			}
			proof.DeviceCode = first.body["device_code"].(string)
			proof.Name, proof.Serial, proof.Platform = "", "", ""
			pending := call("/api/v1/device-enrollments/token", signEnrollment(proof, "poll", private), 200)
			if pending.err != nil || pending.body["status"] != "pending" {
				t.Errorf("fleet pending progress failed: %v", pending.err)
				return
			}
			throttled := call("/api/v1/device-enrollments/token", signEnrollment(proof, "poll", private), 429)
			if throttled.err != nil {
				t.Error(throttled.err)
			}
		}()
	}
	workers.Wait()
	var total, uniqueKeys, uniqueCodes int
	if err := f.db.QueryRow(`SELECT count(*),count(DISTINCT public_key),count(DISTINCT user_code) FROM authz_device_enrollments`).Scan(&total, &uniqueKeys, &uniqueCodes); err != nil {
		t.Fatal(err)
	}
	if total != devices || uniqueKeys != devices || uniqueCodes != devices {
		t.Fatal("fleet concurrency duplicated enrollments or mixed device identities/codes")
	}
}
