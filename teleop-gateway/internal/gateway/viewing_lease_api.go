package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/livekit/protocol/auth"
	"github.com/redis/go-redis/v9"
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
		"POST /api/vehicles/{vehicle_id}/viewing/{viewing_session_id}/token":   api.token,
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
	if _, ok := requestVehicleRegistry(r, api.registry).byID[vehicleID]; !ok {
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
	token, ok := viewingToken(w, r, vehicleID, sid)
	if !ok {
		return
	}
	lease, err := api.store.mutate(r.Context(), "acquire", vehicleID, owner, sid)
	if err != nil {
		writeViewingError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: vehicleID,
		SessionID: sid, Event: "viewing_acquire", Result: "success"})
	writeViewingToken(w, lease, token)
}

func viewingToken(w http.ResponseWriter, r *http.Request, vehicleID, sid string) (string, bool) {
	if lkApiKey == "" || lkApiSecret == "" {
		http.Error(w, "viewing token configuration unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	token, err := auth.NewAccessToken(lkApiKey, lkApiSecret).
		AddGrant(operatorVideoGrant(vehicleID, ObserverAccess)).
		SetIdentity("observer-" + sid).SetValidFor(viewingLeaseTTL).ToJWT()
	if err != nil {
		http.Error(w, "failed to issue viewing token", http.StatusInternalServerError)
		return "", false
	}
	return token, reserveManagedToken(w, r, token)
}

func writeViewingToken(w http.ResponseWriter, lease ViewingLease, token string) {
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
	if op == "token" {
		token, ok := viewingToken(w, r, lease.VehicleID, sid)
		if ok {
			// Token reservation can involve storage I/O. Recheck that the lease
			// survived that work without extending its deadline.
			lease, err = api.store.mutate(r.Context(), op, lease.VehicleID, viewingOwner(claims), sid)
			if err != nil {
				writeViewingError(w, err)
				return
			}
			recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: lease.VehicleID,
				SessionID: sid, Event: "viewing_token_refresh", Result: "success"})
			writeViewingToken(w, lease, token)
		}
		return
	}
	writeJSON(w, http.StatusOK, lease)
}

func (api *ViewingLeaseAPI) renew(w http.ResponseWriter, r *http.Request) {
	api.mutate(w, r, "renew")
}

func (api *ViewingLeaseAPI) token(w http.ResponseWriter, r *http.Request) {
	api.mutate(w, r, "token")
}

func (api *ViewingLeaseAPI) release(w http.ResponseWriter, r *http.Request) {
	api.mutate(w, r, "release")
}

var mediaTokenCacheScript = redis.NewScript(`
if redis.call('HGET', KEYS[1], 'epoch') ~= ARGV[1] or
   redis.call('HGET', KEYS[1], 'revision') ~= ARGV[2] then
  return {'stale'}
end
if ARGV[3] == 'read' then
  local token = redis.call('GET', KEYS[2])
  local prefix = ARGV[6] .. '\n'
  if token and string.sub(token, 1, #prefix) == prefix and
     redis.call('PTTL', KEYS[2]) > 120000 then
    return {'ok', string.sub(token, #prefix + 1)}
  end
else
  redis.call('SET', KEYS[2], ARGV[6] .. '\n' .. ARGV[4], 'PX', ARGV[5])
end
return {'ok', ''}
`)

func (api *ViewingLeaseAPI) cachedVehicleMediaToken(w http.ResponseWriter, r *http.Request, demand MediaDemand) (string, bool) {
	vehicleID := demand.VehicleID
	key := vehicleMediaTokenKey(vehicleID)
	keys := []string{"viewing:" + vehicleID + ":demand", key}
	scope := "static"
	if claims, _ := r.Context().Value("user").(*UserClaims); claims != nil && claims.managed != nil {
		scope = "managed:" + claims.Organization
	}
	cache := func(op, token string, ttl time.Duration) ([]string, error) {
		return mediaTokenCacheScript.Run(r.Context(), api.store.client, keys,
			demand.Epoch, demand.Revision, op, token, ttl.Milliseconds(), scope).StringSlice()
	}
	result, err := cache("read", "", 0)
	if err != nil || len(result) != 2 || result[0] != "ok" {
		http.Error(w, "viewing coordination changed or unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	if result[1] != "" {
		if verifier, parseErr := auth.ParseAPIToken(result[1]); parseErr == nil {
			claims, grants, verifyErr := verifier.Verify(lkApiSecret)
			if verifyErr == nil && claims.Subject == "vehicle-"+vehicleID &&
				claims.Expiry != nil && time.Until(claims.Expiry.Time()) > 2*time.Minute &&
				grants.Video != nil && grants.Video.Room == "teleop-"+vehicleID && grants.Video.RoomJoin &&
				grants.Video.GetCanPublish() && grants.Video.GetCanPublishData() && grants.Video.GetCanSubscribe() {
				return result[1], true
			}
		}
	}
	token, err := issueVehicleToken(vehicleID)
	if err != nil {
		return "", true
	}
	if !reserveManagedToken(w, r, token) {
		return "", false
	}
	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		http.Error(w, "invalid vehicle media token", http.StatusInternalServerError)
		return "", false
	}
	claims, _, err := verifier.Verify(lkApiSecret)
	if err != nil || claims.Expiry == nil {
		http.Error(w, "invalid vehicle media token expiry", http.StatusInternalServerError)
		return "", false
	}
	cacheTTL := time.Until(claims.Expiry.Time()) - 2*time.Minute
	if cacheTTL < time.Millisecond {
		http.Error(w, "vehicle media token expires too soon", http.StatusServiceUnavailable)
		return "", false
	}
	result, err = cache("write", token, cacheTTL)
	if err != nil || len(result) != 2 || result[0] != "ok" {
		http.Error(w, "viewing coordination changed or unavailable", http.StatusServiceUnavailable)
		return "", false
	}
	return token, true
}

func (api *ViewingLeaseAPI) demand(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, true) {
		return
	}
	vehicleID := r.PathValue("vehicle_id")
	demand, err := api.store.Demand(r.Context(), vehicleID)
	if err != nil {
		writeViewingError(w, err)
		return
	}
	if demand.RTCRequired && lkApiKey != "" && lkApiSecret != "" &&
		!(managedRuntime != nil && managedRuntime.maintenance) {
		token, ok := api.cachedVehicleMediaToken(w, r, demand)
		if !ok {
			return
		}
		demand.MediaToken = token
	}
	teleopDemandRevision.WithLabelValues(demand.VehicleID).Set(float64(demand.Revision))
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
		teleopGateway503Total.WithLabelValues("VIEWING_COORDINATION_UNAVAILABLE").Inc()
		http.Error(w, "viewing coordination unavailable", http.StatusServiceUnavailable)
	}
}
