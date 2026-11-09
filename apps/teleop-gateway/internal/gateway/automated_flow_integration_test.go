package gateway

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"mime/quotedprintable"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/mail"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

func TestAutomatedOnboardingActualFlow(t *testing.T) {
	if os.Getenv("CASDOOR_CONTRACT_MANAGEMENT_CLIENT") == "" {
		t.Skip("run python3 tests/casdoor-contract.py for actual automated onboarding acceptance")
	}
	ctx := context.Background()
	issuer := os.Getenv("CASDOOR_CONTRACT_ISSUER")
	f := newManagedFixture(t)
	f.runtime.issuer = issuer
	f.orgID, f.adminID = uuid.NewString(), uuid.NewString()
	if err := f.store.Bootstrap(ctx, authorization.BootstrapInput{
		OrganizationID: f.orgID, OrganizationName: "Actual automation fleet", UserID: f.adminID,
		Name: "Actual automation administrator", Issuer: issuer,
		Subject: os.Getenv("CASDOOR_CONTRACT_PERSON_SUBJECT"),
	}); err != nil {
		t.Fatal("could not bind actual test platform identity")
	}
	session, err := f.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var locked bool
	if err := session.QueryRowContext(ctx, `SELECT pg_try_advisory_lock(7439102342056781)`).Scan(&locked); err != nil || !locked {
		session.Close()
		t.Fatal("could not acquire isolated managed instance lock")
	}
	t.Cleanup(func() {
		session.ExecContext(context.Background(), `SELECT pg_advisory_unlock(7439102342056781)`)
		session.Close()
	})
	f.store, err = authorization.NewManagedStore(f.db, session)
	if err != nil {
		t.Fatal(err)
	}
	f.runtime.store, f.runtime.instance = f.store, session
	verifier, err := NewOIDCAuthenticator(issuer, os.Getenv("CASDOOR_CONTRACT_PERSON_AUDIENCE"),
		os.Getenv("CASDOOR_CONTRACT_JWKS_URL"))
	if err != nil {
		t.Fatal(err)
	}
	verifier.machineAudience = f.store.MachineAudienceAllowed
	authenticator = verifier
	mux := http.NewServeMux()
	bootstrapLoss := &vehicleBootstrapResponseLoss{ackLost: make(chan struct{})}
	server := httptest.NewServer(withRequestID(bootstrapLoss.wrap(mux)))
	defer server.Close()
	smtpAddress, mail := onboardingMailSink(t)
	providerRequest := func(method, path string, body any) any {
		t.Helper()
		var payload io.Reader
		if body != nil {
			encoded, _ := json.Marshal(body)
			payload = bytes.NewReader(encoded)
		}
		req, err := http.NewRequest(method, issuer+path, payload)
		if err != nil {
			t.Fatal("invalid isolated provider request")
		}
		req.SetBasicAuth(os.Getenv("CASDOOR_CONTRACT_MANAGEMENT_CLIENT"), os.Getenv("CASDOOR_CONTRACT_MANAGEMENT_SECRET"))
		req.Header.Set("Content-Type", "application/json")
		response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal("actual provider management request failed")
		}
		defer response.Body.Close()
		var envelope struct {
			Status string `json:"status"`
			Data   any    `json:"data"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&envelope) != nil || envelope.Status != "ok" {
			t.Fatalf("actual provider management failed at %s", path)
		}
		return envelope.Data
	}
	smtpHost, smtpPortString, _ := net.SplitHostPort(smtpAddress)
	smtpPort, _ := strconv.Atoi(smtpPortString)
	recoveryProvider := "onboarding-recovery-" + uuid.NewString()[:8]
	providerRequest("POST", "/api/add-provider", map[string]any{
		"owner": "admin", "name": recoveryProvider, "displayName": "Loopback recovery only",
		"category": "Email", "type": "Default", "clientId": "", "clientSecret": "",
		"clientId2": "noreply@example.test", "host": smtpHost, "port": smtpPort, "sslMode": "Disable",
		"title": "WheelOS account setup", "content": `Verification code: %s<reset-link><a href="%link">Set up account</a></reset-link>`,
	})
	browserID := "admin/" + os.Getenv("CASDOOR_CONTRACT_BROWSER_APPLICATION")
	browserApp, ok := providerRequest("GET", "/api/get-application?id="+url.QueryEscape(browserID), nil).(map[string]any)
	if !ok {
		t.Fatal("actual browser application unavailable")
	}
	browserApp["providers"] = []map[string]any{{"name": recoveryProvider, "rule": "forget"}}
	providerRequest("POST", "/api/update-application?id="+url.QueryEscape(browserID), browserApp)
	directory := t.TempDir()
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	keyPath, configPath := filepath.Join(directory, "key"), filepath.Join(directory, "onboarding.json")
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(key)), 0600); err != nil {
		t.Fatal(err)
	}
	configuration := map[string]any{
		"supported_version": "4.25.0", "jwks_url": os.Getenv("CASDOOR_CONTRACT_JWKS_URL"),
		"casdoor_url": issuer, "management_client_id": os.Getenv("CASDOOR_CONTRACT_MANAGEMENT_CLIENT"),
		"management_client_secret": os.Getenv("CASDOOR_CONTRACT_MANAGEMENT_SECRET"),
		"casdoor_organization":     os.Getenv("CASDOOR_CONTRACT_ORGANIZATION"),
		"browser_application":      os.Getenv("CASDOOR_CONTRACT_BROWSER_APPLICATION"),
		"certificate":              "cert-built-in", "gateway_url": server.URL,
		"encryption_key_file": keyPath,
	}
	data, _ := json.Marshal(configuration)
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AUTHORIZATION_ONBOARDING_CONFIG_FILE", configPath)
	service, err := NewOnboardingServiceFromEnvironment(f.store, issuer, f.runtime.BeforeAdditive)
	if err != nil {
		t.Fatalf("configure isolated onboarding: %v", err)
	}
	service.acquireMutation = f.runtime.BeforeMutation
	service.Register(mux, AuthenticationMiddleware)
	(&ManagedAdminAPI{Store: f.store, TrustedIssuer: issuer, BeforeMutation: f.runtime.BeforeMutation,
		OnboardingEnabled: true}).Register(mux, AuthenticationMiddleware)
	mux.Handle("GET /api/auth/me", AuthenticationMiddleware(http.HandlerFunc(handleAuthMe)))
	registerDeviceAuthCheck(mux)
	(&VehicleTelemetryAPI{registry: vehicleRegistry, identities: vehicleIdentities,
		authorizer: vehicleAuthorizer, states: NewVehicleTelemetryStore(f.client, nil),
		leases: controlLeases}).register(mux)
	runCtx, cancel := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); service.Run(runCtx) }()
	defer func() { cancel(); <-workerDone }()
	adminToken := os.Getenv("CASDOOR_CONTRACT_PERSON_TOKEN")
	call := func(method, path, token string, body any, want int) map[string]any {
		t.Helper()
		var payload io.Reader
		if body != nil {
			raw, _ := json.Marshal(body)
			payload = bytes.NewReader(raw)
		}
		req, err := http.NewRequest(method, server.URL+path, payload)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json")
		response, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
		if err != nil {
			t.Fatal("actual Gateway HTTP request failed")
		}
		defer response.Body.Close()
		if response.StatusCode != want {
			t.Fatalf("%s %s status=%d want=%d code=%s", method, path, response.StatusCode, want, response.Header.Get("X-Error-Code"))
		}
		result := map[string]any{}
		if want < 400 && want != 204 {
			if err := json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&result); err != nil {
				t.Fatal("Gateway response was not a bounded object")
			}
		}
		return result
	}
	base := "/api/admin/organizations/" + f.orgID + "/onboarding"
	await := func(id, status string) map[string]any {
		t.Helper()
		deadline := time.Now().Add(35 * time.Second)
		for time.Now().Before(deadline) {
			result := call("GET", base+"/"+id, adminToken, nil, 200)
			if result["status"] == status {
				return result
			}
			if result["status"] == "failed" {
				t.Fatalf("actual onboarding failed stage=%v code=%v", result["stage"], result["error_code"])
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatal("actual onboarding did not reach expected state")
		return nil
	}
	// Exercise the public proof-authenticated registration path with actual
	// Casdoor credentials/JWKS and the production managed HTTP middleware.
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	enrollment := enrollmentProof{RequestID: uuid.NewString(), PublicKey: base64.RawURLEncoding.EncodeToString(publicKey),
		Name: "Device-code vehicle", Serial: "ACTUAL-TEST-SN", Platform: "test"}
	created := call("POST", "/api/v1/device-enrollments", "", signEnrollment(enrollment, "create", privateKey), 201)
	enrollmentAdmin := "/api/admin/organizations/" + f.orgID + "/device-enrollments"
	call("POST", enrollmentAdmin+"/lookup", adminToken, map[string]any{"user_code": created["user_code"]}, 200)
	approved := call("POST", enrollmentAdmin+"/"+enrollment.RequestID+"/approve", adminToken,
		map[string]any{"name": "Device-code vehicle", "vehicle_number": "enrolled-001"}, 202)
	await(approved["operation_id"].(string), "awaiting_install")
	enrollment.DeviceCode = created["device_code"].(string)
	enrollment.Name, enrollment.Serial, enrollment.Platform = "", "", ""
	ready := call("POST", "/api/v1/device-enrollments/token", "", signEnrollment(enrollment, "poll", privateKey), 200)
	enrollment.Ticket = ready["ticket"].(string)
	provisioned := call("POST", "/api/v1/device-enrollments/complete", "", signEnrollment(enrollment, "complete", privateKey), 200)
	retried := call("POST", "/api/v1/device-enrollments/complete", "", signEnrollment(enrollment, "complete", privateKey), 200)
	if provisioned["client_secret"] != retried["client_secret"] {
		t.Fatal("proof-authenticated lost-response retry changed credentials")
	}
	deviceGrant, err := http.PostForm(provisioned["token_url"].(string), url.Values{
		"grant_type": {"client_credentials"}, "client_id": {provisioned["client_id"].(string)},
		"client_secret": {provisioned["client_secret"].(string)}, "scope": {"teleop:vehicle"},
	})
	if err != nil {
		t.Fatal("device-code vehicle grant failed")
	}
	var granted struct {
		AccessToken string `json:"access_token"`
	}
	err = json.NewDecoder(io.LimitReader(deviceGrant.Body, 65536)).Decode(&granted)
	deviceGrant.Body.Close()
	if err != nil || granted.AccessToken == "" {
		t.Fatal("device-code vehicle grant returned no access token")
	}
	enrolledVehicle := provisioned["vehicle_id"].(string)
	call("GET", "/api/vehicles/"+enrolledVehicle+"/device-auth-check", granted.AccessToken, nil, 204)
	call("POST", "/api/vehicles/"+enrolledVehicle+"/installation-complete", granted.AccessToken, map[string]any{}, 204)
	call("POST", "/api/v1/device-enrollments/complete", "", signEnrollment(enrollment, "complete", privateKey), 404)
	if os.Getenv("VEHICLE_BOOTSTRAP_TEST_BINARY") != "" {
		client := newVehicleBootstrapClient(t, server.URL, "ACTUAL-CPP-SN")
		bootstrapLoss.complete.Store(true)
		bootstrapLoss.ack.Store(true)
		began := time.Now()
		process := client.start(75 * time.Second)
		var enrollmentID, userCode string
		waitForBootstrap(t, 12*time.Second, "actual Casdoor device approval", func() bool {
			return f.db.QueryRow(`SELECT enrollment_id,user_code FROM authz_device_enrollments WHERE serial='ACTUAL-CPP-SN'`).Scan(&enrollmentID, &userCode) == nil
		})
		call("POST", enrollmentAdmin+"/lookup", adminToken, map[string]any{"user_code": userCode}, 200)
		approval := call("POST", enrollmentAdmin+"/"+enrollmentID+"/approve", adminToken,
			map[string]any{"name": "Actual C++ vehicle", "vehicle_number": "cpp-actual-001"}, 202)
		operationID := approval["operation_id"].(string)
		await(operationID, "awaiting_install")
		waitForBootstrap(t, 60*time.Second, "lost acknowledgment after actual installation", func() bool {
			select {
			case <-bootstrapLoss.ackLost:
				return true
			case <-process.done:
				t.Fatalf("actual vehicle client stopped before acknowledgment: %v", process.err)
				return false
			default:
				return false
			}
		})
		process.stop()
		await(operationID, "completed")
		config := client.read("device.json")
		state := client.read("state/enrollment.json")
		if state["status"] != "installing" || config["vehicle_id"] != approval["vehicle_id"] ||
			config["control_mode"] != "disabled" || bootstrapLoss.complete.Load() {
			t.Fatal("lost responses did not preserve installed credentials and pending acknowledgment")
		}
		restarted := client.start(25 * time.Second)
		if err := restarted.wait(); err != nil || client.read("state/enrollment.json")["status"] != "installed" {
			t.Fatal("actual C++ client could not recover a lost acknowledgment after restart")
		}
		originalSecret := config["client_secret"].(string)
		if strings.Contains(process.output.String(), originalSecret) || strings.Contains(restarted.output.String(), originalSecret) {
			t.Fatal("actual vehicle output leaked its client credential")
		}
		t.Logf("real C++/Casdoor: lost credential response and acknowledgment recovered across restart in %s", time.Since(began).Round(time.Millisecond))

		// A confirmed rejection is induced in disposable local configuration;
		// only the normal enrollment approval is allowed to rotate Casdoor.
		config["client_secret"] = "invalid-disposable-test-credential"
		client.write("device.json", config)
		recoveryProcess := client.start(30 * time.Second)
		var recoveryID, recoveryCode string
		waitForBootstrap(t, 18*time.Second, "actual invalid_client recovery", func() bool {
			return f.db.QueryRow(`SELECT enrollment_id,user_code FROM authz_device_enrollments WHERE recovery AND operation_id=$1 AND status='pending'`, operationID).Scan(&recoveryID, &recoveryCode) == nil
		})
		recoveryProcess.stop()
		pendingRestart := client.start(6 * time.Second)
		pendingRestart.wait()
		recoveryView := call("POST", enrollmentAdmin+"/lookup", adminToken, map[string]any{"user_code": recoveryCode}, 200)
		if recoveryView["id"] != recoveryID || recoveryView["vehicle_id"] != approval["vehicle_id"] ||
			recoveryView["operation_id"] != operationID || recoveryView["recovery"] != true {
			t.Fatal("actual credential failure lost its original organization/vehicle binding")
		}
		call("POST", enrollmentAdmin+"/"+recoveryID+"/approve", adminToken, map[string]any{}, 409)
		f.runtime.maintenance = true
		call("POST", enrollmentAdmin+"/"+recoveryID+"/approve", adminToken, map[string]any{}, 409)
		t.Log("real credential recovery: waiting the actual 11-minute Gateway quiet window; no test-clock advance or drain bypass")
		waitForBootstrap(t, 12*time.Minute, "actual safe maintenance quiet window", func() bool {
			quietUntil, err := f.store.DrainQuietUntil(ctx)
			if err != nil {
				t.Fatal(err)
			}
			return !quietUntil.IsZero() && !time.Now().Before(quietUntil)
		})
		rotated := call("POST", enrollmentAdmin+"/"+recoveryID+"/approve", adminToken, map[string]any{}, 202)
		f.runtime.maintenance = false
		if rotated["operation_id"] != operationID {
			t.Fatal("actual recovery created another provisioning operation")
		}
		if err := client.start(40 * time.Second).wait(); err != nil {
			t.Fatal("approved actual Casdoor credential recovery did not finish")
		}
		renewed := client.read("device.json")
		if renewed["vehicle_id"] != config["vehicle_id"] || renewed["client_id"] != config["client_id"] ||
			renewed["client_secret"] == originalSecret || renewed["control_mode"] != "disabled" {
			t.Fatal("actual recovery changed identity/control settings or failed to rotate credentials")
		}
		old, err := http.PostForm(config["token_url"].(string), url.Values{
			"grant_type": {"client_credentials"}, "client_id": {config["client_id"].(string)},
			"client_secret": {originalSecret},
		})
		if err != nil {
			t.Fatal("could not verify actual old-credential rejection")
		}
		var oldGrant map[string]any
		err = json.NewDecoder(io.LimitReader(old.Body, 65536)).Decode(&oldGrant)
		old.Body.Close()
		if err != nil || oldGrant["access_token"] != nil {
			t.Fatal("old credential still obtained a grant after recovery approval")
		}
		var requests, operations int
		if err := f.db.QueryRow(`SELECT count(*) FROM authz_device_enrollments WHERE serial='ACTUAL-CPP-SN'`).Scan(&requests); err != nil || requests != 2 {
			t.Fatal("actual recovery or restart repeatedly refreshed the device code")
		}
		if err := f.db.QueryRow(`SELECT count(*) FROM authz_onboarding_operations WHERE vehicle_id=$1`, config["vehicle_id"]).Scan(&operations); err != nil || operations != 1 {
			t.Fatal("actual recovery duplicated the vehicle")
		}
		for _, path := range []string{"device.json", "state/key.json", "state/enrollment.json"} {
			info, err := os.Stat(filepath.Join(client.dir, path))
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("actual vehicle did not protect credentials or enrollment state")
			}
		}
		await(operationID, "completed")
		t.Log("real C++/Casdoor: invalid_client, pending restart, maintenance-gated approval, secret rotation and same-vehicle recovery passed")
	}
	vehicleInput := map[string]any{"kind": "vehicle", "name": "Actual enrolled vehicle",
		"vehicle_number": "truck-001", "idempotency_key": uuid.NewString()}
	vehicleID := ""
	// A live signaling reader must not prevent fresh-identity transactions.
	id := func() string {
		f.runtime.mu.RLock()
		defer f.runtime.mu.RUnlock()
		vehicle := call("POST", base, adminToken, vehicleInput, 202)
		id, ok := vehicle["id"].(string)
		if !ok {
			t.Fatal("operation has no persistent ID")
		}
		vehicleID, ok = vehicle["vehicle_id"].(string)
		if !ok || !regexp.MustCompile(`^v-[a-f0-9]{8}-truck-001-[a-f0-9]{16}$`).MatchString(vehicleID) {
			t.Fatal("vehicle ID did not follow the trusted organization/number/random rule")
		}
		await(id, "awaiting_install")
		return id
	}()
	if retry := call("POST", base, adminToken, vehicleInput, 202); retry["id"] != id {
		t.Fatal("idempotent submission created another operation")
	}
	// Redeem once, simulate a lost installation response, then explicitly reissue.
	ticket := call("POST", base+"/"+id+"/installation-ticket", adminToken, map[string]any{}, 201)
	first, ok := ticket["token"].(string)
	if !ok {
		t.Fatal("installation ticket missing")
	}
	lost := call("POST", "/api/vehicle/install", first, map[string]any{}, 200)
	var ciphertext []byte
	if err := f.db.QueryRow(`SELECT credential_ciphertext FROM authz_onboarding_operations WHERE operation_id=$1`, id).Scan(&ciphertext); err != nil ||
		len(ciphertext) == 0 || bytes.Contains(ciphertext, []byte(lost["client_secret"].(string))) {
		t.Fatal("pending permanent credential was not encrypted at rest")
	}
	operationJSON, _ := json.Marshal(call("GET", base+"/"+id, adminToken, nil, 200))
	if bytes.Contains(operationJSON, []byte(lost["client_secret"].(string))) {
		t.Fatal("operation status exposed a permanent credential")
	}
	second := call("POST", base+"/"+id+"/installation-ticket", adminToken, map[string]any{}, 201)
	token, ok := second["token"].(string)
	if !ok || token == first {
		t.Fatal("explicit credential recovery did not issue a fresh single-use ticket")
	}
	form := url.Values{"grant_type": {"client_credentials"}, "client_id": {lost["client_id"].(string)},
		"client_secret": {lost["client_secret"].(string)}, "scope": {"teleop:vehicle"}}
	oldGrant, err := http.PostForm(lost["token_url"].(string), form)
	if err != nil {
		t.Fatal("actual rotated-secret check failed")
	}
	var denied map[string]any
	err = json.NewDecoder(io.LimitReader(oldGrant.Body, 65536)).Decode(&denied)
	oldGrant.Body.Close()
	if err != nil || denied["access_token"] != nil {
		t.Fatal("previously delivered secret obtained a new grant after explicit recovery")
	}
	ticketPath, devicePath := filepath.Join(directory, "ticket"), filepath.Join(directory, "device.json")
	if err := os.WriteFile(ticketPath, []byte(token), 0600); err != nil {
		t.Fatal(err)
	}
	installer := filepath.Join("..", "..", "..", "..", "infra", "scripts", "install-vehicle-auth.py")
	command := exec.CommandContext(ctx, "python3", installer, "--gateway", server.URL,
		"--vehicle-id", vehicleID, "--ticket-file", ticketPath, "--output", devicePath, "--allow-insecure-localhost")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("actual installer failed: %v; %s", err, output)
	}
	await(id, "completed")
	if err := f.db.QueryRow(`SELECT credential_ciphertext FROM authz_onboarding_operations WHERE operation_id=$1`, id).Scan(&ciphertext); err != nil || len(ciphertext) != 0 {
		t.Fatal("completed installation retained its recoverable permanent credential")
	}
	installed, err := os.Stat(devicePath)
	if err != nil || installed.Mode().Perm() != 0600 {
		t.Fatal("actual installer did not preserve protected device configuration")
	}
	call("POST", "/api/vehicle/install", token, map[string]any{}, 401)
	personInput := map[string]any{"kind": "person", "name": "Actual invited viewer",
		"email": "operator-" + uuid.NewString()[:8] + "@example.test", "role": "viewer",
		"idempotency_key": uuid.NewString()}
	person := call("POST", base, adminToken, personInput, 202)
	personID, ok := person["id"].(string)
	if !ok {
		t.Fatal("person onboarding has no operation ID")
	}
	person = await(personID, "completed")
	var invitationMail onboardingTestMail
	select {
	case notification := <-mail:
		invitationMail = notification
		if !strings.Contains(notification.recipient, personInput["email"].(string)) ||
			!strings.Contains(notification.body, issuer) {
			t.Fatal("welcome notification did not reach the intended test mailbox")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("person onboarding did not deliver a welcome notification")
	}
	userID, ok := person["user_id"].(string)
	if !ok {
		t.Fatal("completed personnel operation has no bound user ID")
	}
	observe, err := f.store.Enforce(ctx, userID, f.orgID, vehicleID, authorization.ActionCameraLiveView)
	if err != nil || !observe {
		t.Fatal("person's default member baseline did not grant own-organization observe permission")
	}
	control, err := f.store.Enforce(ctx, userID, f.orgID, vehicleID, authorization.ActionRemoteControl)
	if err != nil || control {
		t.Fatal("new viewer received control")
	}
	if retry := call("POST", base, adminToken, personInput, 202); retry["id"] != personID {
		t.Fatal("person submission retry created another identity")
	}
	var nativeUser map[string]any
	for _, entry := range providerRequest("GET", "/api/get-users?owner="+url.QueryEscape(os.Getenv("CASDOOR_CONTRACT_ORGANIZATION")), nil).([]any) {
		candidate := entry.(map[string]any)
		if candidate["email"] == personInput["email"] {
			nativeUser = candidate
		}
	}
	if nativeUser == nil {
		t.Fatal("new person has no actual Casdoor account")
	}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	publicClient := &http.Client{Timeout: 10 * time.Second, Jar: jar}
	publicPost := func(path string, fields map[string]string, multipartForm bool) any {
		t.Helper()
		var payload bytes.Buffer
		contentType := "application/json"
		if multipartForm {
			writer := multipart.NewWriter(&payload)
			for key, value := range fields {
				if err := writer.WriteField(key, value); err != nil {
					t.Fatal("could not construct native recovery request")
				}
			}
			writer.Close()
			contentType = writer.FormDataContentType()
		} else {
			json.NewEncoder(&payload).Encode(fields)
		}
		req, err := http.NewRequest("POST", issuer+path, &payload)
		if err != nil {
			t.Fatal("invalid native recovery endpoint")
		}
		req.Header.Set("Content-Type", contentType)
		response, err := publicClient.Do(req)
		if err != nil {
			t.Fatal("native recovery request transport failed")
		}
		defer response.Body.Close()
		var envelope struct {
			Status string `json:"status"`
			Data   any    `json:"data"`
			Msg    string `json:"msg"`
		}
		if json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&envelope) != nil || envelope.Status != "ok" {
			var categories []string
			for _, category := range []string{"captcha", "email", "provider", "user", "application", "exist", "password", "empty", "smtp", "connection", "client", "disabled", "code", "invalid", "required", "timeout", "check", "secret", "method", "not allowed"} {
				if strings.Contains(strings.ToLower(envelope.Msg), category) {
					categories = append(categories, category)
				}
			}
			t.Fatalf("native recovery/login failed at %s; categories=%v", strings.SplitN(path, "?", 2)[0], categories)
		}
		return envelope.Data
	}
	message, err := mailpkgRead(invitationMail.body)
	if err != nil {
		t.Fatal("invalid recovery notification")
	}
	linkMatch := regexp.MustCompile(`href="([^"]+)"`).FindStringSubmatch(message)
	if len(linkMatch) != 2 {
		t.Fatal("native invitation contains no account setup link")
	}
	setupURL, err := url.Parse(strings.ReplaceAll(linkMatch[1], "&amp;", "&"))
	if err != nil || setupURL.Scheme+"://"+setupURL.Host != issuer ||
		setupURL.Path != "/forget/"+os.Getenv("CASDOOR_CONTRACT_BROWSER_APPLICATION") ||
		setupURL.Query().Get("username") != nativeUser["name"] {
		t.Fatal("native account setup link has the wrong trusted origin or account")
	}
	setupPage, err := publicClient.Get(setupURL.String())
	if err != nil {
		t.Fatal("actual native account setup page is not reachable")
	}
	setupPage.Body.Close()
	if setupPage.StatusCode != 200 {
		t.Fatal("actual native account setup page is unavailable")
	}
	code := setupURL.Query().Get("code")
	if !regexp.MustCompile(`^[0-9]{6}$`).MatchString(code) {
		t.Fatal("native setup link has no bounded verification code")
	}
	publicPost("/api/verify-code", map[string]string{
		"application":  os.Getenv("CASDOOR_CONTRACT_BROWSER_APPLICATION"),
		"organization": os.Getenv("CASDOOR_CONTRACT_ORGANIZATION"),
		"username":     personInput["email"].(string), "name": nativeUser["name"].(string),
		"code": code, "type": "login",
	}, false)
	passwordBytes := make([]byte, 24)
	rand.Read(passwordBytes)
	password := base64.RawURLEncoding.EncodeToString(passwordBytes) + "!Aa9"
	publicPost("/api/set-password", map[string]string{
		"userOwner": os.Getenv("CASDOOR_CONTRACT_ORGANIZATION"), "userName": nativeUser["name"].(string),
		"oldPassword": "", "newPassword": password, "code": code,
	}, true)
	pkceBytes := make([]byte, 48)
	rand.Read(pkceBytes)
	pkceVerifier := base64.RawURLEncoding.EncodeToString(pkceBytes)
	digest := sha256.Sum256([]byte(pkceVerifier))
	authorizationQuery := url.Values{
		"clientId": {os.Getenv("CASDOOR_CONTRACT_BROWSER_CLIENT")}, "responseType": {"code"},
		"redirectUri": {"http://127.0.0.1:8000/"}, "scope": {"openid profile teleop:observe"},
		"state": {uuid.NewString()}, "code_challenge_method": {"S256"},
		"code_challenge": {base64.RawURLEncoding.EncodeToString(digest[:])},
	}
	authorizationCode := publicPost("/api/login?"+authorizationQuery.Encode(), map[string]string{
		"type": "code", "organization": os.Getenv("CASDOOR_CONTRACT_ORGANIZATION"),
		"application": os.Getenv("CASDOOR_CONTRACT_BROWSER_APPLICATION"), "username": personInput["email"].(string),
		"password": password, "signinMethod": "Password",
	}, false).(string)
	personGrant, err := http.PostForm(issuer+"/api/login/oauth/access_token", url.Values{
		"grant_type": {"authorization_code"}, "client_id": {os.Getenv("CASDOOR_CONTRACT_BROWSER_CLIENT")},
		"code": {authorizationCode}, "code_verifier": {pkceVerifier}, "redirect_uri": {"http://127.0.0.1:8000/"},
	})
	if err != nil {
		t.Fatal("new person PKCE exchange failed")
	}
	var personnelTokens map[string]any
	err = json.NewDecoder(io.LimitReader(personGrant.Body, 65536)).Decode(&personnelTokens)
	personGrant.Body.Close()
	personnelAccess, ok := personnelTokens["access_token"].(string)
	if err != nil || !ok {
		t.Fatal("new person did not receive an actual access token")
	}
	me := call("GET", "/api/auth/me", personnelAccess, nil, 200)
	if me["Name"] != userID {
		t.Fatal("new person's actual login did not resolve to the authorized identity")
	}
	call("GET", "/api/vehicles/"+vehicleID+"/state", personnelAccess, nil, 200)
	if _, err := f.store.AssignManagedRole(ctx, authorization.Assignment{
		ActorUserID: f.adminID, UserID: userID, OrganizationID: f.orgID,
		Role: authorization.RoleViewer, Scope: authorization.ScopeSelected, VehicleIDs: []string{vehicleID},
	}); err != nil {
		t.Fatal("subsequent explicit assignment failed")
	}
	call("GET", "/api/vehicles/"+vehicleID+"/state", personnelAccess, nil, 200)
	t.Log("Actual native invitation link/reset/PKCE, default organization read with no execution, preserved explicit assignment, generated vehicle ID and protected installation passed")
}

func mailpkgRead(raw string) (string, error) {
	message, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		return "", err
	}
	var body io.Reader = message.Body
	switch strings.ToLower(message.Header.Get("Content-Transfer-Encoding")) {
	case "quoted-printable":
		body = quotedprintable.NewReader(body)
	case "base64":
		body = base64.NewDecoder(base64.StdEncoding, body)
	}
	decoded, err := io.ReadAll(io.LimitReader(body, 65536))
	return string(decoded), err
}

type onboardingTestMail struct {
	recipient string
	body      string
}

func onboardingMailSink(t *testing.T) (string, <-chan onboardingTestMail) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	messages := make(chan onboardingTestMail, 16)
	var mu sync.Mutex
	connections := make(map[net.Conn]bool)
	t.Cleanup(func() {
		listener.Close()
		mu.Lock()
		defer mu.Unlock()
		for conn := range connections {
			conn.Close()
		}
	})
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			mu.Lock()
			connections[conn] = true
			mu.Unlock()
			go func() {
				defer func() {
					conn.Close()
					mu.Lock()
					delete(connections, conn)
					mu.Unlock()
				}()
				conn.SetDeadline(time.Now().Add(30 * time.Second))
				reader := bufio.NewReader(conn)
				fmt.Fprint(conn, "220 loopback-test ESMTP\r\n")
				recipient := ""
				for {
					line, err := reader.ReadString('\n')
					if err != nil {
						return
					}
					switch command := strings.ToUpper(strings.TrimSpace(line)); {
					case strings.HasPrefix(command, "EHLO"):
						fmt.Fprint(conn, "250-loopback-test\r\n250 8BITMIME\r\n")
					case strings.HasPrefix(command, "HELO"), strings.HasPrefix(command, "MAIL FROM"), command == "RSET":
						fmt.Fprint(conn, "250 OK\r\n")
					case strings.HasPrefix(command, "RCPT TO:"):
						recipient = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "RCPT TO:"))
						fmt.Fprint(conn, "250 OK\r\n")
					case command == "DATA":
						fmt.Fprint(conn, "354 End with dot\r\n")
						var body strings.Builder
						for {
							line, err = reader.ReadString('\n')
							if err != nil || body.Len()+len(line) > 256<<10 {
								return
							}
							if line == ".\r\n" {
								break
							}
							body.WriteString(line)
						}
						select {
						case messages <- onboardingTestMail{recipient: recipient, body: body.String()}:
							fmt.Fprint(conn, "250 Accepted\r\n")
						default:
							fmt.Fprint(conn, "452 Test mailbox full\r\n")
						}
					case command == "QUIT":
						fmt.Fprint(conn, "221 Bye\r\n")
						return
					default:
						fmt.Fprint(conn, "502 Unsupported\r\n")
					}
				}
			}()
		}
	}()
	return listener.Addr().String(), messages
}
