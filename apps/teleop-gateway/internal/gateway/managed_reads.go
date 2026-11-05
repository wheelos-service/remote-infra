package gateway

import (
	"net/http"
	"strconv"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func (api *ManagedAdminAPI) registerReads(mux *http.ServeMux, authenticate func(http.Handler) http.Handler) {
	for _, pattern := range []string{"GET /api/admin/organizations/{org_id}/audit", "GET /api/admin/organizations/{org_id}/people/{user_id}/registration", "GET /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/registration"} {
		mux.Handle(pattern, authenticate(http.HandlerFunc(api.serveManagementRead)))
	}
}

func (api *ManagedAdminAPI) serveManagementRead(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims == nil || claims.UserID == "" || claims.Issuer != api.TrustedIssuer {
		writeDiagnosticError(w, r, "a bound human identity is required", "MANAGED_IDENTITY_REQUIRED", http.StatusForbidden)
		return
	}
	org := r.PathValue("org_id")
	if !onboardingUUID(org) {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	if api.Store == nil {
		writeDiagnosticError(w, r, "managed store unavailable", "MANAGED_STORE_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	target, kind := r.PathValue("user_id"), "person"
	if id := r.PathValue("vehicle_id"); id != "" {
		target, kind = id, "vehicle"
	}
	if target != "" {
		result, err := api.Store.Registration(r.Context(), claims.UserID, org, target, kind)
		if err != nil {
			managedAdminError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	q := r.URL.Query()
	for key, values := range q {
		if len(values) != 1 {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		switch key {
		case "cursor", "actor", "target", "action", "outcome", "from", "until", "limit":
		default:
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
	}
	f := authorization.AuditFilter{Cursor: q.Get("cursor"), Actor: q.Get("actor"), Target: q.Get("target"), Action: q.Get("action"), Outcome: q.Get("outcome")}
	var err error
	if q.Has("limit") {
		f.Limit, err = strconv.Atoi(q.Get("limit"))
		if err != nil || f.Limit < 1 {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
	}
	if q.Has("from") {
		f.From, err = time.Parse(time.RFC3339Nano, q.Get("from"))
		if err != nil {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
	}
	if q.Has("until") {
		f.Until, err = time.Parse(time.RFC3339Nano, q.Get("until"))
		if err != nil {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
	}
	result, err := api.Store.Audit(r.Context(), claims.UserID, org, f)
	if err != nil {
		managedAdminError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

type authenticatedResponse struct {
	http.ResponseWriter
	status int
}

func (w *authenticatedResponse) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w *authenticatedResponse) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *authenticatedResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(body)
}
