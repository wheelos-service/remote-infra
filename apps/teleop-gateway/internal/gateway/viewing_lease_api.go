package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/auth"
)

type ViewingLeaseAPI struct {
	store      *ViewingLeaseStore
	registry   *VehicleRegistry
	authorizer *VehicleAuthorizer
	identities *VehicleIdentityResolver
}

func (api *ViewingLeaseAPI) register(mux *http.ServeMux) {
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/vehicles/{vehicle_id}/viewing/acquire":                      api.acquire,
		"POST /api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/renew":   api.renew,
		"POST /api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/release": api.release,
		"GET /api/vehicles/{vehicle_id}/media-demand":                          api.demand,
	} {
		mux.Handle(pattern, vehicleTelemetryNoStore(AuthenticationMiddleware(handler)))
	}
}

func (api *ViewingLeaseAPI) authorize(w http.ResponseWriter, r *http.Request, device bool) bool {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	allowed := canObserve(claims) && api.authorizer.Authorize(claims, vehicleID, ObservePermission)
	if device {
		allowed = vehicleSelfMatches(claims, vehicleID, api.identities)
	}
	if !allowed {
		http.Error(w, "forbidden: vehicle permission required", http.StatusForbidden)
		return false
	}
	if _, ok := api.registry.byID[vehicleID]; !ok {
		http.Error(w, "vehicle not registered", http.StatusNotFound)
		return false
	}
	return true
}

func (api *ViewingLeaseAPI) acquire(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, false) {
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil {
		http.Error(w, "invalid viewing request size", http.StatusBadRequest)
		return
	}
	var request struct {
		RequestID        string `json:"request_id"`
		ClientInstanceID string `json:"client_instance_id"`
	}
	if rejectDuplicateJSONFields(raw) != nil || json.Unmarshal(raw, &request) != nil {
		http.Error(w, "invalid viewing request", http.StatusBadRequest)
		return
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fields)
	if len(fields) != 2 || fields["request_id"] == nil || fields["client_instance_id"] == nil ||
		!validViewingUUID(request.RequestID) || !validViewingUUID(request.ClientInstanceID) {
		http.Error(w, "viewing request requires request_id and client_instance_id UUIDs", http.StatusBadRequest)
		return
	}
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	owner := viewingOwner(claims)
	sid := viewingSessionID(vehicleID, owner, request.ClientInstanceID, request.RequestID)
	if lkApiKey == "" || lkApiSecret == "" {
		http.Error(w, "viewing token configuration unavailable", http.StatusServiceUnavailable)
		return
	}
	token, err := auth.NewAccessToken(lkApiKey, lkApiSecret).
		AddGrant(operatorVideoGrant(vehicleID, ObserverAccess)).
		SetIdentity("observer-" + sid).SetValidFor(15 * time.Minute).ToJWT()
	if err != nil {
		http.Error(w, "failed to issue viewing token", http.StatusInternalServerError)
		return
	}
	lease, err := api.store.mutate(r.Context(), "acquire", vehicleID, owner, sid)
	if err != nil {
		writeViewingError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: vehicleID,
		SessionID: sid, Event: "viewing_acquire", Result: "success"})
	writeJSON(w, http.StatusOK, struct {
		ViewingLease
		Token string `json:"token"`
	}{lease, token})
}

func validViewingUUID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id.String() == value
}

func (api *ViewingLeaseAPI) mutate(w http.ResponseWriter, r *http.Request, op string) {
	if !api.authorize(w, r, false) {
		return
	}
	sid := r.PathValue("viewing_session_id")
	if !validViewingUUID(sid) {
		http.Error(w, "invalid viewing session id", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1))
	if err != nil || len(body) != 0 {
		http.Error(w, "viewing mutation requires an empty body", http.StatusBadRequest)
		return
	}
	claims := r.Context().Value("user").(*UserClaims)
	lease, err := api.store.mutate(r.Context(), op, r.PathValue("vehicle_id"), viewingOwner(claims), sid)
	if op == "release" && errors.Is(err, errViewingGone) {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if err != nil {
		writeViewingError(w, err)
		return
	}
	if op == "release" {
		recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: lease.VehicleID,
			SessionID: sid, Event: "viewing_release", Result: "success"})
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

func (api *ViewingLeaseAPI) renew(w http.ResponseWriter, r *http.Request) {
	api.mutate(w, r, "renew")
}

func (api *ViewingLeaseAPI) release(w http.ResponseWriter, r *http.Request) {
	api.mutate(w, r, "release")
}

func (api *ViewingLeaseAPI) demand(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, true) {
		return
	}
	demand, err := api.store.Demand(r.Context(), r.PathValue("vehicle_id"))
	if err != nil {
		writeViewingError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, demand)
}

func writeViewingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errViewingGone):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, errViewingOwner):
		http.Error(w, err.Error(), http.StatusForbidden)
	case errors.Is(err, errViewingLimit):
		http.Error(w, err.Error(), http.StatusTooManyRequests)
	default:
		http.Error(w, "viewing coordination unavailable", http.StatusServiceUnavailable)
	}
}
