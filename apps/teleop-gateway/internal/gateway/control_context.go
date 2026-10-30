package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// Simulation confirmation is deliberately separate from the physical ACK gate.
func simulationControlEnabled(vehicleID string) bool {
	var vehicles []string
	if json.Unmarshal([]byte(os.Getenv("SIMULATED_CONTROL_VEHICLES_JSON")), &vehicles) != nil {
		return false
	}
	for _, id := range vehicles {
		if id == vehicleID {
			return true
		}
	}
	return false
}

type DeviceControlContext struct {
	VehicleID  string          `json:"vehicle_id"`
	Revision   int64           `json:"revision"`
	State      string          `json:"state"`
	SessionID  string          `json:"session_id"`
	TTLMS      int64           `json:"ttl_ms"`
	Session    *ControlSession `json:"session"`
	Simulation bool            `json:"simulation"`
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
	out := DeviceControlContext{VehicleID: vehicleID, Simulation: simulationControlEnabled(vehicleID)}
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
	if err != nil || json.Unmarshal(raw, &session) != nil || session.ProtocolVersion != 2 {
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
