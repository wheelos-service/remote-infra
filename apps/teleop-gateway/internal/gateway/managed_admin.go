package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/google/uuid"
)

// ManagedAdminAPI is the manual-provisioning pilot, not a Casdoor credential
// service. Every write requires the runtime drain guard, including expansions.
type ManagedAdminAPI struct {
	Store             *authorization.Store
	TrustedIssuer     string
	BeforeMutation    func(context.Context, string) (func(), error)
	Onboarding        *OnboardingService
	OnboardingEnabled bool
}

func (api *ManagedAdminAPI) Register(mux *http.ServeMux, authenticate func(http.Handler) http.Handler) {
	api.registerLifecycle(mux, authenticate)
	api.registerReads(mux, authenticate)
	for _, pattern := range []string{
		"GET /api/organizations/context",
		"GET /api/admin/context",
		"GET /api/admin/organizations/{org_id}/people",
		"POST /api/admin/organizations/{org_id}/people",
		"POST /api/admin/organizations/{org_id}/members",
		"GET /api/admin/organizations/{org_id}/vehicles",
		"POST /api/admin/organizations/{org_id}/vehicles",
		"POST /api/admin/organizations/{org_id}/assignments",
	} {
		mux.Handle(pattern, authenticate(http.HandlerFunc(api.serveHTTP)))
	}
}

func (api *ManagedAdminAPI) serveHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims == nil || claims.UserID == "" || claims.Issuer != api.TrustedIssuer {
		writeDiagnosticError(w, r, "a bound human identity is required", "MANAGED_IDENTITY_REQUIRED", http.StatusForbidden)
		return
	}
	if api.Store == nil || api.TrustedIssuer == "" {
		writeDiagnosticError(w, r, "managed authorization is unavailable", "MANAGED_STORE_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	if r.URL.Path == "/api/organizations/context" {
		result, err := api.Store.MemberContext(r.Context(), claims.UserID)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, struct {
			Mode string `json:"mode"`
			authorization.MemberContext
		}{Mode: "managed", MemberContext: result})
		return
	}
	if r.URL.Path == "/api/admin/context" {
		result, err := api.Store.ManagedContext(r.Context(), claims.UserID)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		if api.OnboardingEnabled {
			result.ManualProvisioning = false
			result.IdentityProvisioning = "Gateway-managed Casdoor onboarding; existing identity rebinding remains restricted."
		}
		writeJSON(w, http.StatusOK, struct {
			authorization.ManagementContext
			OnboardingEnabled bool `json:"onboarding_enabled"`
		}{result, api.OnboardingEnabled})
		return
	}
	orgID := r.PathValue("org_id")
	id, err := uuid.Parse(orgID)
	if err != nil || id.String() != orgID {
		writeDiagnosticError(w, r, "invalid organization ID", "MANAGED_INVALID_REQUEST", http.StatusBadRequest)
		return
	}
	if r.Method == http.MethodGet {
		var result any
		switch {
		case r.Pattern == "GET /api/admin/organizations/{org_id}/people":
			result, err = api.Store.ListPeople(r.Context(), claims.UserID, orgID, api.TrustedIssuer)
		default:
			result, err = api.Store.ListVehicles(r.Context(), claims.UserID, orgID, api.TrustedIssuer)
		}
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	var person struct {
		Name    string `json:"name"`
		Subject string `json:"subject"`
	}
	var vehicle struct {
		VehicleID string `json:"vehicle_id"`
		Name      string `json:"name"`
		Subject   string `json:"subject"`
	}
	var assignment struct {
		UserID          string              `json:"user_id"`
		Role            authorization.Role  `json:"role"`
		Scope           authorization.Scope `json:"scope"`
		VehicleIDs      []string            `json:"vehicle_ids"`
		ExpectedVersion *int64              `json:"expected_version,omitempty"`
	}
	switch r.Pattern {
	case "POST /api/admin/organizations/{org_id}/members":
		err = decodeManagedBody(w, r, &person, "subject")
	case "POST /api/admin/organizations/{org_id}/people":
		err = decodeManagedBody(w, r, &person, "name", "subject")
	case "POST /api/admin/organizations/{org_id}/vehicles":
		err = decodeManagedBody(w, r, &vehicle, "vehicle_id", "name", "subject")
	default:
		err = decodeManagedBody(w, r, &assignment, "user_id", "role", "scope", "vehicle_ids", "expected_version")
	}
	if err != nil {
		writeDiagnosticError(w, r, "expected a bounded JSON object with unique, recognized fields", "MANAGED_INVALID_REQUEST", http.StatusBadRequest)
		return
	}
	allowed, err := api.Store.CanManageOrganization(r.Context(), claims.UserID, orgID)
	if err != nil {
		managedAdminError(w, r, err)
		return
	}
	if !allowed {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	if api.BeforeMutation == nil {
		writeDiagnosticError(w, r, "management writes require a runtime drain guard", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	release, err := api.BeforeMutation(r.Context(), orgID)
	if err != nil {
		if errors.Is(err, errManagedDrain) || errors.Is(err, errManagedMaintenance) {
			writeDiagnosticError(w, r, err.Error(), "MANAGED_DRAIN_REQUIRED", http.StatusConflict)
		} else {
			writeDiagnosticError(w, r, "management drain verification is unavailable", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		}
		return
	}
	if release == nil {
		writeDiagnosticError(w, r, "management drain guard is unavailable", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	defer release()
	// Authorization is rechecked by the store transaction after acquiring the
	// guard; a pre-guard administrator snapshot cannot authorize a stale write.
	switch r.Pattern {
	case "POST /api/admin/organizations/{org_id}/members":
		result, err := api.Store.AddExistingMember(r.Context(), claims.UserID, orgID, api.TrustedIssuer, person.Subject)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, result)
	case "POST /api/admin/organizations/{org_id}/people":
		result, err := api.Store.RegisterPerson(r.Context(), claims.UserID, orgID, api.TrustedIssuer, person.Name, person.Subject)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, result)
	case "POST /api/admin/organizations/{org_id}/vehicles":
		result, err := api.Store.RegisterVehicle(r.Context(), claims.UserID, orgID, api.TrustedIssuer, vehicle.VehicleID, vehicle.Name, vehicle.Subject)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusCreated, result)
	default:
		version, err := api.Store.AssignManagedRole(r.Context(), authorization.Assignment{ActorUserID: claims.UserID, UserID: assignment.UserID, OrganizationID: orgID,
			Role: assignment.Role, Scope: assignment.Scope, VehicleIDs: assignment.VehicleIDs, ExpectedVersion: assignment.ExpectedVersion})
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]int64{"authorization_version": version})
	}
}

func managedAdminError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, authorization.ErrInvalidRegistration), errors.Is(err, authorization.ErrInvalidAssignment):
		writeDiagnosticError(w, r, "invalid management request", "MANAGED_INVALID_REQUEST", http.StatusBadRequest)
	case errors.Is(err, authorization.ErrIdentityBindingRestricted):
		writeDiagnosticError(w, r, "only platform operators may bind manually provisioned identities; organization administrators may add already-bound people", "MANAGED_BINDING_RESTRICTED", http.StatusForbidden)
	case errors.Is(err, authorization.ErrNotOrganizationAdmin), errors.Is(err, authorization.ErrInactiveLifecycle):
		writeDiagnosticError(w, r, "organization management is not authorized", "MANAGED_ORGANIZATION_FORBIDDEN", http.StatusForbidden)
	case errors.Is(err, authorization.ErrSelfAssignment):
		writeDiagnosticError(w, r, "self registration or role assignment is not permitted", "MANAGED_SELF_ASSIGNMENT", http.StatusForbidden)
	case errors.Is(err, authorization.ErrLastOrganizationAdmin):
		writeDiagnosticError(w, r, "the last organization administrator cannot be removed", "MANAGED_LAST_ADMIN", http.StatusConflict)
	case errors.Is(err, authorization.ErrConflict):
		writeDiagnosticError(w, r, "resource already exists or concurrent change; refresh before retrying", "MANAGED_CONFLICT", http.StatusConflict)
	default:
		writeDiagnosticError(w, r, "managed authorization storage is unavailable", "MANAGED_STORE_UNAVAILABLE", http.StatusServiceUnavailable)
	}
}

func decodeManagedBody(w http.ResponseWriter, r *http.Request, target any, fields ...string) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token != json.Delim('{') {
		return errors.New("expected object")
	}
	values := make(map[string]json.RawMessage)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return err
		}
		field, ok := token.(string)
		if !ok || !allowed[field] {
			return errors.New("unknown field")
		}
		if _, duplicate := values[field]; duplicate {
			return errors.New("duplicate field")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		values[field] = value
	}
	if _, err := decoder.Token(); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("trailing JSON")
	}
	data, err := json.Marshal(values)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}
