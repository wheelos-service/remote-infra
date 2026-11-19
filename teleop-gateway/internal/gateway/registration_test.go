package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

type registrationProviderFixture struct {
	mu         sync.Mutex
	invitation *registrationInvitation
	user       map[string]any
	app        map[string]any
	creates    int
	loseCreate bool
}

func registrationProvider(t *testing.T, s *OnboardingService) *registrationProviderFixture {
	t.Helper()
	f := &registrationProviderFixture{app: map[string]any{"owner": "admin", "name": "browser", "organization": "fleet",
		"enablePassword": true, "enableSignUp": true, "signupItems": []map[string]any{
			{"name": "Username", "visible": true, "required": true},
			{"name": "Password", "visible": true, "required": true},
			{"name": "Invitation code", "visible": true, "required": true},
		}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if id, secret, ok := r.BasicAuth(); !ok || id != s.config.ManagementClientID || secret != s.config.ManagementClientSecret {
			t.Error("provider management request lacks authentication")
		}
		var result any
		switch r.URL.Path {
		case "/api/get-application":
			result = f.app
		case "/api/get-user":
			result = f.user
		case "/api/get-invitation":
			result = f.invitation
		case "/api/add-invitation":
			if r.Method != http.MethodPost {
				t.Error("invitation must use POST")
			}
			if err := json.NewDecoder(r.Body).Decode(&f.invitation); err != nil {
				t.Error(err)
			}
			f.creates++
			if f.loseCreate {
				w.WriteHeader(http.StatusBadGateway)
				return
			}
			result = true
		default:
			t.Errorf("unexpected provider action: %s (signup must not create users or send email)", r.URL.Path)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok", "data": result})
	}))
	t.Cleanup(server.Close)
	s.config.CasdoorURL, s.config.CasdoorOrganization, s.config.BrowserApplication = server.URL, "fleet", "browser"
	return f
}

func (f *registrationProviderFixture) signup(op authorization.OnboardingOperation) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := uuid.NewString()
	f.user = map[string]any{"id": id, "owner": "fleet", "name": op.Name, "signupApplication": "browser",
		"type": "normal-user", "invitation": op.ProviderName, "invitationCode": f.invitation.Code,
		"createdTime": time.Now().UTC().Format(time.RFC3339)}
	f.invitation.UsedCount = 1
	return id
}

func TestRegistrationUsesNativeInvitationAndReconcilesUnknownCreation(t *testing.T) {
	s := onboardingTestService(t)
	f := registrationProvider(t, s)
	f.loseCreate = true
	code, err := s.newRegistrationCode()
	if err != nil {
		t.Fatal(err)
	}
	op := authorization.OnboardingOperation{Kind: "person", Name: "new-operator", ProviderName: "teleop-" + uuid.NewString(),
		CreatedAt: time.Now(), CredentialCiphertext: code}
	for i := 0; i < 2; i++ {
		if err := s.ensureRegistration(context.Background(), op); err != nil {
			t.Fatal(err)
		}
	}
	if f.creates != 1 || f.invitation.Quota != 1 || f.invitation.Username != op.Name || len(f.invitation.Code) != 64 {
		t.Fatal("invitation was duplicated or not single-use and username-bound")
	}
	if subject, err := s.registeredPerson(context.Background(), op); err != nil || subject != "" {
		t.Fatal("unregistered identity accepted")
	}
	id := f.signup(op)
	if subject, err := s.registeredPerson(context.Background(), op); err != nil || subject != id {
		t.Fatal("native signup identity rejected", err)
	}
	for _, field := range []string{"id", "owner", "name", "signupApplication", "invitation", "invitationCode", "type", "createdTime"} {
		previous := f.user[field]
		f.user[field] = "unrelated"
		if _, err := s.registeredPerson(context.Background(), op); !errors.Is(err, onboardingProviderConflict) {
			t.Errorf("accepted conflicting %s", field)
		}
		f.user[field] = previous
	}
	for _, field := range []string{"isAdmin", "isForbidden", "isDeleted"} {
		f.user[field] = true
		if _, err := s.registeredPerson(context.Background(), op); !errors.Is(err, onboardingProviderConflict) {
			t.Errorf("accepted %s", field)
		}
		delete(f.user, field)
	}
	f.invitation.Quota = 2
	if _, err := s.registeredPerson(context.Background(), op); !errors.Is(err, onboardingProviderConflict) {
		t.Fatal("accepted widened invitation")
	}
}

func TestRegistrationRejectsExistingUsersAndUnsafeApplication(t *testing.T) {
	s := onboardingTestService(t)
	f := registrationProvider(t, s)
	code, _ := s.newRegistrationCode()
	op := authorization.OnboardingOperation{Name: "existing", ProviderName: "teleop-" + uuid.NewString(), CreatedAt: time.Now(), CredentialCiphertext: code}
	f.user = map[string]any{"id": uuid.NewString(), "name": op.Name}
	if err := s.ensureRegistration(context.Background(), op); !errors.Is(err, onboardingProviderConflict) || f.creates != 0 {
		t.Fatal("adopted an existing user")
	}
	f.user = nil
	for _, items := range [][]map[string]any{
		{{"name": "Username", "visible": true, "required": true}, {"name": "Password", "visible": true, "required": true}},
		{{"name": "Username", "visible": true, "required": true}, {"name": "Password", "visible": true, "required": true},
			{"name": "Invitation code", "visible": true, "required": true}, {"name": "Email", "visible": true}},
	} {
		f.app["signupItems"] = items
		if err := s.ensureRegistration(context.Background(), op); !errors.Is(err, onboardingProviderConflict) || f.creates != 0 {
			t.Fatal("unsafe/email signup configuration accepted")
		}
	}
}

func TestPostgresRegistrationLinkBindsOnlyAfterCasdoorSignup(t *testing.T) {
	f := newManagedFixture(t)
	s := onboardingTestService(t)
	s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
	provider := registrationProvider(t, s)
	s.Register(f.mux, AuthenticationMiddleware)
	path := "/api/admin/organizations/" + f.orgID + "/onboarding"
	body := `{"kind":"person","name":"new-operator","role":"remote_operator","idempotency_key":"` + uuid.NewString() + `"}`
	f.request(t, "POST", path, "viewer", "", body, 403)
	created := f.request(t, "POST", path, "admin", "", body, 202)
	var view authorization.OnboardingOperation
	if json.Unmarshal(created.Body.Bytes(), &view) != nil {
		t.Fatal("invalid operation")
	}
	duplicate := f.request(t, "POST", path, "admin", "", body, 202)
	var again authorization.OnboardingOperation
	_ = json.Unmarshal(duplicate.Body.Bytes(), &again)
	if view.ID != again.ID {
		t.Fatal("uncertain submission created another invitation")
	}
	load := func() authorization.OnboardingOperation {
		op, err := f.store.GetOnboarding(context.Background(), f.adminID, f.orgID, view.ID)
		if err != nil {
			t.Fatal(err)
		}
		return op
	}
	op := load()
	s.process(context.Background(), op)
	op = load()
	if op.Status != "awaiting_registration" || op.UserID != "" {
		t.Fatal("user bound before native signup")
	}
	linkPath := path + "/" + op.ID + "/registration-link"
	f.request(t, "POST", linkPath, "viewer", "", "{}", 403)
	f.request(t, "POST", "/api/admin/organizations/"+f.otherOrgID+"/onboarding/"+op.ID+"/registration-link", "admin", "", "{}", 409)
	linkResponse := f.request(t, "POST", linkPath, "admin", "", "{}", 200)
	var link struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(linkResponse.Body.Bytes(), &link)
	u, err := url.Parse(link.URL)
	if err != nil || !strings.HasPrefix(link.URL, s.issuer+"/signup/browser?") || u.Query().Get("invitationCode") != provider.invitation.Code || linkResponse.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("invalid registration link")
	}
	list := f.request(t, "GET", path, "admin", "", "", 200)
	if strings.Contains(list.Body.String(), provider.invitation.Code) || strings.Contains(list.Body.String(), "credential") {
		t.Fatal("directory disclosed invitation credential")
	}
	for _, status := range []string{"running", "pending", "awaiting_registration"} {
		if _, err := f.db.Exec(`UPDATE authz_onboarding_operations SET status=$2 WHERE operation_id=$1`, op.ID, status); err != nil {
			t.Fatal(err)
		}
		f.request(t, "POST", linkPath, "admin", "", "{}", 200)
	}
	// Waiting is not a failed attempt and must not consume the three retry limit.
	for i := 0; i < 4; i++ {
		s.process(context.Background(), load())
	}
	if load().Attempts != 0 {
		t.Fatal("waiting invite consumed retries")
	}
	subject := provider.signup(op)
	s.process(context.Background(), load())
	completed := load()
	if completed.Status != "completed" || len(completed.CredentialCiphertext) != 0 {
		t.Fatal("registration did not finish or retained invitation")
	}
	user, err := f.store.ResolveUser(context.Background(), managedTestIssuer, subject)
	if err != nil || user != op.PlannedIdentityID {
		t.Fatal("verified Casdoor subject was not bound to reserved internal user")
	}
	f.request(t, "POST", linkPath, "admin", "", "{}", 409)
	f.request(t, "GET", "/api/vehicles", subject, f.orgID, "", 200)
	f.request(t, "POST", "/api/vehicles/car-one/control/acquire", subject, f.orgID, `{}`, 403)
}

func TestPostgresRegistrationExpiresAndRechecksInviterAuthority(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "revoked", true: "expired"}[expired], func(t *testing.T) {
			f := newManagedFixture(t)
			s := onboardingTestService(t)
			s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
			provider := registrationProvider(t, s)
			code, _ := s.newRegistrationCode()
			req := authorization.OnboardingRequest{Kind: "person", Name: "new-viewer", Role: authorization.RoleViewer, IdempotencyKey: uuid.NewString()}
			op, err := f.store.CreateOnboarding(context.Background(), f.adminID, f.orgID, req, code)
			if err != nil {
				t.Fatal(err)
			}
			if expired {
				_, err = f.db.Exec(`UPDATE authz_onboarding_operations SET created_at=now()-interval '8 days' WHERE operation_id=$1`, op.ID)
				if err != nil {
					t.Fatal(err)
				}
				op, _ = f.store.GetOnboarding(context.Background(), f.adminID, f.orgID, op.ID)
			}
			s.process(context.Background(), op)
			if !expired {
				provider.signup(op)
				_, err = f.db.Exec(`UPDATE authz_users SET status='disabled' WHERE user_id=$1`, f.adminID)
				if err != nil {
					t.Fatal(err)
				}
				s.process(context.Background(), op)
			}
			var count int
			if err := f.db.QueryRow(`SELECT count(*) FROM authz_users WHERE user_id=$1`, op.PlannedIdentityID).Scan(&count); err != nil || count != 0 {
				t.Fatal("expired/revoked plan granted access")
			}
			if expired {
				if _, err := f.store.RetryOnboarding(context.Background(), f.adminID, f.orgID, op.ID); !errors.Is(err, authorization.ErrConflict) {
					t.Fatal("expired code retried")
				}
				req.IdempotencyKey = uuid.NewString()
				if _, err := f.store.CreateOnboarding(context.Background(), f.adminID, f.orgID, req, code); err != nil {
					t.Fatal("expired username could not be invited again", err)
				}
			}
		})
	}
}
