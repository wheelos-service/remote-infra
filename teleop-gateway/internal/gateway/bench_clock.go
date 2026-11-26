package gateway

import (
	"net/http"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// A process-specific clock prevents a restarted Gateway from validating old frames.
var benchClockStart = time.Now()
var benchClockEpoch = uuid.New().ID()

var controlRequestBlocker = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then return 'lease_held' end
if redis.call('HEXISTS', KEYS[2], 'session') == 1 then
  if redis.call('HGET', KEYS[2], 'edge_revocation_applied') == '1' then return 'awaiting_vehicle' end
  return 'awaiting_revocation'
end
if redis.call('EXISTS', KEYS[3]) == 1 then return 'operator_busy' end
return ''
`)

func handleBenchClock(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	id := r.PathValue("vehicle_id")
	if !vehicleSelfMatches(claims, id, vehicleIdentities) && (!canControl(claims) || !vehicleAuthorizer.Authorize(claims, id, ControlPermission)) {
		http.Error(w, "vehicle control permission required", http.StatusForbidden)
		return
	}
	if !nativeBenchEnabled(id) {
		http.Error(w, "generated-camera bench disabled", http.StatusForbidden)
		return
	}
	ttl, err := controlLeases.client.PTTL(r.Context(), receiverKey(id)).Result()
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	blocker, err := controlRequestBlocker.Run(r.Context(), controlLeases.client, []string{controlLeaseKey(id), controlHandoverKey(id), operatorControlKey(claims.Organization, claims.Name)}).Text()
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"control_request_blocker": blocker, "epoch": benchClockEpoch, "elapsed_ms": time.Since(benchClockStart).Milliseconds(), "receiver_ttl_ms": max(int64(0), ttl.Milliseconds())})
}
