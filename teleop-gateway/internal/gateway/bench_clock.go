package gateway

import (
	"net/http"
	"time"

	"github.com/google/uuid"
)

// A process-specific clock prevents a restarted Gateway from validating old frames.
var benchClockStart = time.Now()
var benchClockEpoch = uuid.New().ID()

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
	writeJSON(w, http.StatusOK, map[string]any{"epoch": benchClockEpoch, "elapsed_ms": time.Since(benchClockStart).Milliseconds(), "receiver_ttl_ms": max(int64(0), ttl.Milliseconds())})
}
