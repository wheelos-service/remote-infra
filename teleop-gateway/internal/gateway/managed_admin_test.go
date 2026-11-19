package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
)

func TestManagedBodyRejectsDuplicateUnknownAndOversizedJSON(t *testing.T) {
	for _, body := range []string{
		`{"name":"first","name":"second","subject":"s"}`,
		`{"Name":"case-insensitive-bypass","subject":"s"}`,
		`{"name":"n","subject":"s","issuer":"untrusted"}`,
		`{"name":"n","subject":"s"} {}`,
		`{"name":42,"subject":"s"}`,
		`null`,
		`{"name":"` + strings.Repeat("x", 65<<10) + `","subject":"s"}`,
	} {
		var parsed struct {
			Name    string `json:"name"`
			Subject string `json:"subject"`
		}
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		if err := decodeManagedBody(httptest.NewRecorder(), r, &parsed, "name", "subject"); err == nil {
			t.Fatalf("accepted ambiguous request of length %d", len(body))
		}
	}
}

func managedAdminTestStore(t *testing.T) (*authorization.Store, *sql.DB, authorization.BootstrapInput) {
	t.Helper()
	dsn := os.Getenv("AUTHZ_POSTGRES_TEST_DSN")
	if dsn == "" {
		t.Skip("set AUTHZ_POSTGRES_TEST_DSN for real PostgreSQL managed API tests")
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	admin := stdlib.OpenDB(*config)
	schema := "managed_api_" + uuid.NewString()[:8]
	if _, err := admin.Exec(`CREATE SCHEMA ` + schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	testConfig := config.Copy()
	testConfig.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*testConfig)
	t.Cleanup(func() { db.Close(); admin.Exec(`DROP SCHEMA ` + schema + ` CASCADE`); admin.Close() })
	store, err := authorization.NewStore(db)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	in := authorization.BootstrapInput{OrganizationID: uuid.NewString(), OrganizationName: "API fleet", UserID: uuid.NewString(), Name: "Platform", Issuer: "https://manual-idp.example.test", Subject: "platform"}
	if err := store.Bootstrap(context.Background(), in); err != nil {
		t.Fatal(err)
	}
	return store, db, in
}

func TestManagedAdminRoutesAuthorizationAndGuardedTransactions(t *testing.T) {
	store, db, in := managedAdminTestStore(t)
	ctx := context.Background()
	claims := &UserClaims{Name: in.UserID, UserID: in.UserID, Issuer: in.Issuer}
	api := &ManagedAdminAPI{Store: store, TrustedIssuer: in.Issuer}
	mux := http.NewServeMux()
	api.Register(mux, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), "user", claims)))
		})
	})
	request := func(method, path, body string, want int) *httptest.ResponseRecorder {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Accept", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("%s %s status=%d body=%s want=%d", method, path, w.Code, w.Body.String(), want)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("management response was cacheable")
		}
		return w
	}
	base := "/api/admin/organizations/" + in.OrganizationID
	contextResponse := request(http.MethodGet, "/api/admin/context", "", http.StatusOK)
	var management authorization.ManagementContext
	if err := json.Unmarshal(contextResponse.Body.Bytes(), &management); err != nil || !management.CanBindIdentities || !management.ManualProvisioning || management.Organizations[0].OrganizationID != in.OrganizationID {
		t.Fatalf("context=%+v err=%v", management, err)
	}
	request(http.MethodPost, base+"/people", `{"name":"Person","subject":"person"}`, http.StatusServiceUnavailable)
	if version, _ := store.Version(ctx); version != 1 {
		t.Fatal("unguarded registration wrote database")
	}
	api.BeforeMutation = func(context.Context, string) (func(), error) { return nil, errManagedDrain }
	response := request(http.MethodPost, base+"/people", `{"name":"Person","subject":"person"}`, http.StatusConflict)
	if response.Header().Get("X-Error-Code") != "MANAGED_DRAIN_REQUIRED" {
		t.Fatal("drain error not classified")
	}
	api.BeforeMutation = func(context.Context, string) (func(), error) { return nil, errors.New("database unreachable") }
	request(http.MethodPost, base+"/people", `{"name":"Person","subject":"person"}`, http.StatusServiceUnavailable)

	guardCalls, releases := 0, 0
	api.BeforeMutation = func(_ context.Context, orgID string) (func(), error) {
		if orgID != in.OrganizationID {
			t.Fatal("wrong organization passed to guard")
		}
		before, err := store.Version(ctx)
		if err != nil {
			t.Fatal(err)
		}
		guardCalls++
		return func() {
			releases++
			after, err := store.Version(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if after != before+1 {
				t.Fatalf("guard released before transaction committed: %d -> %d", before, after)
			}
		}, nil
	}
	personResponse := request(http.MethodPost, base+"/people", `{"name":"Person","subject":"person"}`, http.StatusCreated)
	var person authorization.Person
	if err := json.Unmarshal(personResponse.Body.Bytes(), &person); err != nil {
		t.Fatal(err)
	}
	request(http.MethodPost, base+"/vehicles", `{"vehicle_id":"car-api","name":"API car","subject":"device-api"}`, http.StatusCreated)
	request(http.MethodPost, base+"/assignments", `{"user_id":"`+person.UserID+`","role":"remote_operator","scope":"selected","vehicle_ids":["car-api"]}`, http.StatusOK)
	if guardCalls != 3 || releases != 3 {
		t.Fatalf("guards=%d releases=%d want3/3", guardCalls, releases)
	}
	list := request(http.MethodGet, base+"/people", "", http.StatusOK)
	if !strings.Contains(list.Body.String(), `"remote_operator"`) || !strings.Contains(list.Body.String(), `"car-api"`) {
		t.Fatalf("assignment not listed: %s", list.Body)
	}
	vehicles := request(http.MethodGet, base+"/vehicles", "", http.StatusOK)
	if !strings.Contains(vehicles.Body.String(), `"subject":"device-api"`) {
		t.Fatalf("vehicle subject not listed: %s", vehicles.Body)
	}
	guardCallsBefore := guardCalls
	request(http.MethodPost, base+"/people", `{"name":"Bad","subject":"s","subject":"duplicate"}`, http.StatusBadRequest)
	if guardCalls != guardCallsBefore {
		t.Fatal("invalid body entered mutation guard")
	}
	// A guard failure after authorization must release on a rejected write too.
	api.BeforeMutation = func(context.Context, string) (func(), error) { guardCalls++; return func() { releases++ }, nil }
	request(http.MethodPost, base+"/assignments", `{"user_id":"`+in.UserID+`","role":"remote_operator","scope":"all"}`, http.StatusForbidden)
	if guardCalls != releases {
		t.Fatal("failed transaction leaked mutation guard")
	}
	claims = &UserClaims{Name: person.UserID, UserID: person.UserID, Issuer: in.Issuer}
	request(http.MethodGet, "/api/admin/context", "", http.StatusForbidden)
	request(http.MethodGet, base+"/people", "", http.StatusForbidden)
	request(http.MethodGet, base+"/vehicles", "", http.StatusForbidden)
	request(http.MethodPost, base+"/people", `{"name":"Unauthorized","subject":"new"}`, http.StatusForbidden)
	claims = &UserClaims{Name: in.UserID, UserID: in.UserID, Issuer: "https://other.example.test"}
	request(http.MethodGet, "/api/admin/context", "", http.StatusForbidden)
	// Revocation that happens while the guard is acquired is rechecked in the
	// write transaction, not authorized from the earlier HTTP precheck.
	admin, err := store.RegisterPerson(ctx, in.UserID, in.OrganizationID, in.Issuer, "Admin", "org-admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.AssignManagedRole(ctx, authorization.Assignment{ActorUserID: in.UserID, UserID: admin.UserID, OrganizationID: in.OrganizationID, Role: authorization.RoleOrgAdmin, Scope: authorization.ScopeAll}); err != nil {
		t.Fatal(err)
	}
	claims = &UserClaims{Name: admin.UserID, UserID: admin.UserID, Issuer: in.Issuer}
	api.BeforeMutation = func(context.Context, string) (func(), error) {
		_, err := db.Exec(`UPDATE authz_organization_memberships SET status='suspended' WHERE org_id=$1 AND user_id=$2`, in.OrganizationID, admin.UserID)
		if err != nil {
			t.Fatal(err)
		}
		return func() {}, nil
	}
	request(http.MethodPost, base+"/people", `{"name":"Attempt","subject":"new-attempt"}`, http.StatusForbidden)
}
