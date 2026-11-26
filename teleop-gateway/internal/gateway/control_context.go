package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// Simulation confirmation is deliberately separate from the physical ACK gate.
func simulationControlEnabled(vehicleID string) bool {
	return listedControlVehicle("SIMULATED_CONTROL_VEHICLES_JSON", vehicleID)
}

func listedControlVehicle(setting, vehicleID string) bool {
	var vehicles []string
	if json.Unmarshal([]byte(os.Getenv(setting)), &vehicles) != nil {
		return false
	}
	for _, id := range vehicles {
		if id == vehicleID {
			return true
		}
	}
	return false
}

var nativeInstance = regexp.MustCompile(`^[a-f0-9]{32}$`)

func receiverKey(id string) string { return "control-receiver:" + id }

func nativeControlEnabled(claims *UserClaims, vehicleID string) bool {
	if simulationControlEnabled(vehicleID) {
		return false
	}
	if managed := claims.managed; managed != nil {
		// Managed claims are resolved from active enrollment and grants on every request.
		return managed.deviceID == vehicleID || managed.permissions[vehicleID][ControlPermission]
	}
	return listedControlVehicle("NATIVE_BENCH_VEHICLES_JSON", vehicleID)
}

type ControlTimingPolicy struct {
	ControlTickMS       int64 `json:"control_tick_ms"`
	WatchdogPauseMS     int64 `json:"watchdog_pause_ms"`
	WatchdogLockMS      int64 `json:"watchdog_lock_ms"`
	RTCReconnectGraceMS int64 `json:"rtc_reconnect_grace_ms"`
	MediaPauseGraceMS   int64 `json:"media_pause_grace_ms"`
	ACKBudgetMS         int64 `json:"ack_budget_ms"`
	FeedbackTimeoutMS   int64 `json:"feedback_timeout_ms"`
	ContextTTLMS        int64 `json:"context_ttl_ms"`
}

// Single authoritative derivation from three primitives: tick cadence (50ms),
// packet-drop pause budget (6 ticks = 300ms), and lock multiple (5x = 1500ms).
func defaultControlTimingPolicy() ControlTimingPolicy {
	const (
		tickMS          int64 = 50
		pauseDropFactor int64 = 6 // tolerates 5 consecutive Lossy drops
		lockFactor      int64 = 5 // 5 * 300ms = 1500ms
		mediaGraceMS    int64 = 5000
		contextTTLMS    int64 = 5000
	)
	pauseMS := tickMS * pauseDropFactor
	lockMS := pauseMS * lockFactor
	return ControlTimingPolicy{
		ControlTickMS:       tickMS,
		WatchdogPauseMS:     pauseMS,
		WatchdogLockMS:      lockMS,
		RTCReconnectGraceMS: lockMS - pauseMS,
		MediaPauseGraceMS:   mediaGraceMS,
		ACKBudgetMS:         pauseMS * 2,
		FeedbackTimeoutMS:   pauseMS*3 + tickMS*2,
		ContextTTLMS:        contextTTLMS,
	}
}

type DeviceControlContext struct {
	VehicleID    string               `json:"vehicle_id"`
	Revision     int64                `json:"revision"`
	State        string               `json:"state"`
	SessionID    string               `json:"session_id"`
	TTLMS        int64                `json:"ttl_ms"`
	Session      *ControlSession      `json:"session"`
	Simulation   bool                 `json:"simulation"`
	TimingPolicy *ControlTimingPolicy `json:"timing_policy,omitempty"`
}

var deviceControlContextScript = redis.NewScript(`
local revision = redis.call('HGET', KEYS[1], 'revision') or '0'
local raw = redis.call('GET', KEYS[2])
local ttl = redis.call('PTTL', KEYS[2])
local held = redis.call('HGET', KEYS[1], 'session')
if raw and ttl > 0 then
  if not held or cjson.decode(held).session_id ~= cjson.decode(raw).session_id
    or redis.call('HGET', KEYS[1], 'state') ~= 'ACTIVE' then
    return redis.error_reply('control fence mismatch')
  end
  return {revision, 'ACTIVE', cjson.decode(raw).session_id, tostring(ttl), raw}
end
if held then return {revision, 'PENDING', cjson.decode(held).session_id, '0', ''} end
return {revision, redis.call('HGET', KEYS[1], 'state') or 'NONE',
  redis.call('HGET', KEYS[1], 'confirmed_session') or '', '0', ''}
`)

func (s *ControlLeaseStore) DeviceContext(ctx context.Context, vehicleID string) (DeviceControlContext, error) {
	policy := defaultControlTimingPolicy()
	out := DeviceControlContext{
		VehicleID:    vehicleID,
		Simulation:   simulationControlEnabled(vehicleID),
		TimingPolicy: &policy,
	}
	values, err := deviceControlContextScript.Run(ctx, s.client,
		[]string{controlHandoverKey(vehicleID), controlLeaseKey(vehicleID)}).StringSlice()
	if err != nil {
		return out, err
	}
	if len(values) != 5 {
		return out, errors.New("invalid device control context")
	}
	out.Revision, err = strconv.ParseInt(values[0], 10, 64)
	if err != nil || out.Revision < 0 || out.Revision > maxTelemetryInteger {
		return out, errors.New("invalid control revision")
	}
	out.State, out.SessionID = values[1], values[2]
	out.TTLMS, err = strconv.ParseInt(values[3], 10, 64)
	if err != nil || out.TTLMS < 0 {
		return out, errors.New("invalid control TTL")
	}
	if values[4] != "" {
		out.Session = new(ControlSession)
		if json.Unmarshal([]byte(values[4]), out.Session) != nil || out.Session.VehicleID != vehicleID {
			return out, errors.New("invalid control session")
		}
	}
	return out, nil
}

func registerDeviceControl(mux *http.ServeMux) {
	mux.Handle("GET /api/vehicles/{vehicle_id}/control/context/native-v3-percent/{instance}", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleDeviceControlContext))))
	mux.Handle("GET /api/vehicles/{vehicle_id}/control/bench-clock", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleBenchClock))))
	mux.Handle("GET /api/vehicles/{vehicle_id}/control/context",
		vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleDeviceControlContext))))
	mux.Handle("POST /api/vehicles/{vehicle_id}/control/simulation-ack",
		vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleSimulationAck))))
}

func handleDeviceControlContext(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	if !vehicleSelfMatches(claims, r.PathValue("vehicle_id"), vehicleIdentities) {
		http.Error(w, "vehicle identity required", http.StatusForbidden)
		return
	}
	state, err := controlLeases.DeviceContext(r.Context(), r.PathValue("vehicle_id"))
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if instance := r.PathValue("instance"); instance != "" {
		if !nativeInstance.MatchString(instance) {
			http.Error(w, "invalid receiver instance", 400)
			return
		}
		if err := controlLeases.client.Set(r.Context(), receiverKey(state.VehicleID), instance, 5*time.Second).Err(); err != nil {
			writeControlSessionError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"contract_version": 3, "vehicle_id": state.VehicleID, "state": state.State, "revision": state.Revision, "session": state.Session, "session_id": state.SessionID, "ttl_ms": state.TTLMS, "timing_policy": state.TimingPolicy})
		return
	}
	writeJSON(w, http.StatusOK, state)
}

func handleSimulationAck(w http.ResponseWriter, r *http.Request) {
	vehicleID := r.PathValue("vehicle_id")
	claims := r.Context().Value("user").(*UserClaims)
	if !vehicleSelfMatches(claims, vehicleID, vehicleIdentities) || !simulationControlEnabled(vehicleID) {
		http.Error(w, "simulation vehicle required", http.StatusForbidden)
		return
	}
	var ack struct {
		SessionID string `json:"session_id"`
		Revision  int64  `json:"revision"`
	}
	rawBody, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 512))
	var fields map[string]json.RawMessage
	if readErr != nil || rejectDuplicateJSONFields(rawBody) != nil ||
		json.Unmarshal(rawBody, &ack) != nil || json.Unmarshal(rawBody, &fields) != nil ||
		len(fields) != 2 || fields["session_id"] == nil || fields["revision"] == nil ||
		ack.SessionID == "" || len(ack.SessionID) > 64 || ack.Revision <= 0 || ack.Revision > maxTelemetryInteger {
		http.Error(w, "invalid simulation acknowledgement", http.StatusBadRequest)
		return
	}
	current, err := controlLeases.DeviceContext(r.Context(), vehicleID)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if current.State == "CONFIRMED" && current.SessionID == ack.SessionID && current.Revision == ack.Revision {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if current.State != "PENDING" || current.SessionID != ack.SessionID || current.Revision != ack.Revision {
		http.Error(w, "simulation revocation not pending", http.StatusConflict)
		return
	}
	// Only sessions created under the explicit v2 simulation contract qualify.
	raw, err := controlLeases.client.HGet(r.Context(), controlHandoverKey(vehicleID), "session").Bytes()
	var session ControlSession
	if err != nil || json.Unmarshal(raw, &session) != nil || session.ProtocolVersion != 2 || session.ContractVersion != 0 {
		http.Error(w, "not a simulation session", http.StatusConflict)
		return
	}
	if err = controlLeases.ReportHandover(r.Context(), vehicleID, ack.SessionID, ack.Revision, true); err != nil {
		writeControlSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{VehicleID: vehicleID, SessionID: ack.SessionID,
		Event: "simulation_handover_confirmed", Result: "simulated_not_physical"})
	w.WriteHeader(http.StatusNoContent)
}
