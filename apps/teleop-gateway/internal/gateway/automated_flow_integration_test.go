package gateway

import (
	"bufio"
	"bytes"
	"context"
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
	server := httptest.NewServer(withRequestID(mux))
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
		OnboardingEnabled: true, Onboarding: service}).Register(mux, AuthenticationMiddleware)
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
	packageBytes, err := json.Marshal(struct {
		SchemaVersion int       `json:"schema_version"`
		GatewayURL    string    `json:"gateway_url"`
		VehicleID     string    `json:"vehicle_id"`
		OperationID   string    `json:"operation_id"`
		ExpiresAt     time.Time `json:"expires_at"`
		Ticket        string    `json:"installation_ticket"`
	}{1, server.URL, vehicleID, id, time.Now().Add(5 * time.Minute), token})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ticketPath, packageBytes, 0600); err != nil {
		t.Fatal(err)
	}
	installer := filepath.Join("..", "..", "..", "..", "infra", "scripts", "install-vehicle-auth.py")
	command := exec.CommandContext(ctx, "python3", installer, "--gateway", server.URL,
		"--vehicle-id", vehicleID, "--package", ticketPath, "--output", devicePath, "--allow-insecure-localhost")
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
	version, err := f.store.Version(ctx)
	if err != nil {
		t.Fatal(err)
	}
	service.workMu.Lock()
	replacementSecret, err := onboardingRandom()
	if err != nil {
		t.Fatal(err)
	}
	replacementCiphertext, err := service.encryptCredential(replacementSecret)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := f.store.Lifecycle(ctx, f.adminID, f.orgID, vehicleID, "credential_rotate", authorization.LifecycleRequest{IdempotencyKey: uuid.NewString(), ExpectedVersion: version, Reason: "Actual provider revocation acceptance"}, true, replacementCiphertext)
	service.workMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for {
		state, err := f.store.GetLifecycle(ctx, f.adminID, f.orgID, revoked.ID)
		if err != nil {
			t.Fatal(err)
		}
		if state.ProviderStatus == "confirmed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("actual provider revocation did not confirm")
		}
		time.Sleep(100 * time.Millisecond)
	}
	registered, err := f.store.GetOnboarding(ctx, f.adminID, f.orgID, id)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.ResolveVehicle(ctx, issuer, "admin/"+registered.ProviderName); err == nil {
		t.Fatal("revoked device still resolves")
	}
	installedBytes, err := os.ReadFile(devicePath)
	if err != nil {
		t.Fatal(err)
	}
	var oldDevice struct {
		TokenURL     string `json:"token_url"`
		ClientID     string `json:"client_id"`
		ClientSecret string `json:"client_secret"`
	}
	if json.Unmarshal(installedBytes, &oldDevice) != nil {
		t.Fatal("invalid installed config")
	}
	rejected, err := http.PostForm(oldDevice.TokenURL, url.Values{"grant_type": {"client_credentials"}, "client_id": {oldDevice.ClientID}, "client_secret": {oldDevice.ClientSecret}, "scope": {"teleop:vehicle"}})
	if err != nil {
		t.Fatal("provider revocation probe failed")
	}
	var rejectedGrant struct {
		AccessToken string `json:"access_token"`
	}
	err = json.NewDecoder(io.LimitReader(rejected.Body, 65536)).Decode(&rejectedGrant)
	rejected.Body.Close()
	if err != nil || rejectedGrant.AccessToken != "" {
		t.Fatal("revoked installed credential still obtains grants")
	}
	deadline = time.Now().Add(30 * time.Second)
	var replacement authorization.DeviceRotation
	for {
		replacement, err = f.store.Rotation(ctx, f.adminID, f.orgID, revoked.ID)
		if err != nil {
			t.Fatal(err)
		}
		if replacement.Status == "awaiting_install" {
			break
		}
		if time.Now().After(deadline) {
			state, stateErr := f.store.GetLifecycle(ctx, f.adminID, f.orgID, revoked.ID)
			t.Fatalf("replacement provider reconciliation did not complete: status=%s attempts=%d code=%s read=%v", replacement.Status, replacement.Attempts, state.ErrorCode, stateErr)
		}
		time.Sleep(100 * time.Millisecond)
	}
	replacementTicket := call("POST", "/api/admin/organizations/"+f.orgID+"/lifecycle-operations/"+revoked.ID+"/installation-ticket", adminToken, struct{}{}, 200)
	replacementToken, ok := replacementTicket["token"].(string)
	if !ok {
		t.Fatal("missing replacement ticket")
	}
	replacementPackage, err := json.Marshal(struct {
		SchemaVersion int       `json:"schema_version"`
		GatewayURL    string    `json:"gateway_url"`
		VehicleID     string    `json:"vehicle_id"`
		OperationID   string    `json:"operation_id"`
		ExpiresAt     time.Time `json:"expires_at"`
		Ticket        string    `json:"installation_ticket"`
	}{1, server.URL, vehicleID, revoked.ID, time.Now().Add(5 * time.Minute), replacementToken})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ticketPath, replacementPackage, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(devicePath, devicePath+".protected-backup"); err != nil {
		t.Fatal(err)
	}
	blockedInstall := exec.CommandContext(ctx, "python3", installer, "--gateway", server.URL, "--vehicle-id", vehicleID, "--package", ticketPath, "--output", devicePath, "--allow-insecure-localhost")
	if _, err := blockedInstall.CombinedOutput(); err == nil {
		t.Fatal("replacement activated without maintenance")
	}
	if _, err := os.Stat(devicePath); err != nil {
		t.Fatal("replacement did not reach protected configuration write")
	}
	if _, err := f.store.ResolveVehicle(ctx, issuer, "admin/"+replacement.Operation.ProviderName); err == nil {
		t.Fatal("blocked activation granted ordinary access")
	}
	service.workMu.Lock()
	release, err := f.runtime.BeforeAdditive(ctx, f.orgID)
	if err != nil {
		service.workMu.Unlock()
		t.Fatal(err)
	}
	err = f.store.CompleteRotation(ctx, issuer, vehicleID, "admin/"+replacement.Operation.ProviderName, replacement.Operation.ClientID)
	release()
	service.workMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	resume := exec.CommandContext(ctx, "python3", installer, "--gateway", server.URL, "--vehicle-id", vehicleID, "--verify-existing", "--output", devicePath, "--allow-insecure-localhost")
	if output, err := resume.CombinedOutput(); err != nil {
		t.Fatalf("replacement completion retry failed: %v %s", err, output)
	}
	replacement, err = f.store.Rotation(ctx, f.adminID, f.orgID, revoked.ID)
	if err != nil || replacement.Status != "completed" || len(replacement.Operation.CredentialCiphertext) != 0 {
		t.Fatal("replacement finalization retained pending secret")
	}
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
