package gateway

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"
)

type DataAPI struct {
	store      *OperationsStore
	registry   *VehicleRegistry
	authorizer *VehicleAuthorizer
	identities *VehicleIdentityResolver
}

func (api *DataAPI) register(mux *http.ServeMux) {
	for pattern, handler := range map[string]http.HandlerFunc{
		"POST /api/vehicles/{vehicle_id}/data/health":                        api.health,
		"POST /api/vehicles/{vehicle_id}/data/profile":                       api.profile,
		"POST /api/vehicles/{vehicle_id}/data/diagnostics":                   api.diagnostics,
		"GET /api/vehicles/{vehicle_id}/data/records":                        api.records,
		"POST /api/vehicles/{vehicle_id}/data/events":                        api.event,
		"POST /api/vehicles/{vehicle_id}/data/events/{event_id}/acknowledge": api.acknowledge,
		"POST /api/vehicles/{vehicle_id}/data/tasks":                         api.createTask,
		"GET /api/vehicles/{vehicle_id}/data/tasks/next":                     api.nextTask,
		"POST /api/vehicles/{vehicle_id}/data/task-results":                  api.taskResult,
		"GET /api/vehicles/{vehicle_id}/data":                                api.get,
	} {
		mux.Handle(pattern, vehicleTelemetryNoStore(AuthenticationMiddleware(handler)))
	}
}

func (api *DataAPI) authorize(w http.ResponseWriter, r *http.Request, permission string) bool {
	id := r.PathValue("vehicle_id")
	claims := r.Context().Value("user").(*UserClaims)
	allowed := vehicleSelfMatches(claims, id, api.identities)
	if permission == "observe" {
		allowed = canObserve(claims) && api.authorizer.Authorize(claims, id, ObservePermission)
	}
	if permission == "task" {
		allowed = canControl(claims) && api.authorizer.Authorize(claims, id, ControlPermission)
	}
	if !allowed {
		http.Error(w, "vehicle permission required", 403)
		return false
	}
	if _, ok := api.registry.byID[id]; !ok {
		http.Error(w, "vehicle not registered", 404)
		return false
	}
	return true
}

func readDataJSON(w http.ResponseWriter, r *http.Request, limit int64) ([]byte, map[string]any, bool) {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		http.Error(w, "data payload exceeds limit or cannot be read", 400)
		return nil, nil, false
	}
	if !utf8.Valid(raw) || rejectDuplicateJSONFields(raw) != nil {
		http.Error(w, "invalid data JSON", 400)
		return nil, nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var v map[string]any
	if decoder.Decode(&v) != nil || v == nil {
		http.Error(w, "invalid data object", 400)
		return nil, nil, false
	}
	return raw, v, true
}

func exactData(v map[string]any, fields ...string) bool {
	if len(v) != len(fields) {
		return false
	}
	for _, name := range fields {
		if _, ok := v[name]; !ok {
			return false
		}
	}
	return true
}
func dataString(v any, max int) bool {
	s, ok := v.(string)
	return ok && utf8.ValidString(s) && len(s) <= max
}
func dataID(v any) bool                  { s, ok := v.(string); return ok && telemetryIdentifier.MatchString(s) }
func dataInt(v any, min, max int64) bool { _, ok := telemetryInteger(v, min, max); return ok }
func dataStatus(v any) bool {
	return v == nil || v == "UNKNOWN" || v == "OK" || v == "WARN" || v == "ERROR" || v == "FATAL"
}
func validHealth(v map[string]any, vehicle string) bool {
	if !exactData(v, "schema_version", "type", "vehicle_id", "stream_id", "sequence", "published_at_ms", "sample") ||
		!dataInt(v["schema_version"], 1, 1) || v["type"] != "vehicle_health" || v["vehicle_id"] != vehicle ||
		!dataID(v["stream_id"]) || !dataInt(v["sequence"], 1, maxTelemetryInteger) || !dataInt(v["published_at_ms"], 1, maxTelemetryInteger) {
		return false
	}
	s, ok := v["sample"].(map[string]any)
	if !ok || !exactData(s, "age_ms", "source_timestamp_ms", "source_sequence", "message") {
		return false
	}
	for _, field := range []string{"age_ms", "source_timestamp_ms", "source_sequence"} {
		if s[field] != nil && !dataInt(s[field], 0, maxTelemetryInteger) {
			return false
		}
	}
	if s["message"] == nil {
		return true
	}
	m, ok := s["message"].(map[string]any)
	if !ok || !exactData(m, "components", "hmi_modules", "other_components", "components_truncated",
		"require_emergency_stop", "is_realtime_in_simulation", "passenger_msg", "safety_mode_trigger_time") {
		return false
	}
	for _, field := range []string{"components_truncated", "require_emergency_stop", "is_realtime_in_simulation"} {
		if _, ok := m[field].(bool); !ok && !(field != "components_truncated" && m[field] == nil) {
			return false
		}
	}
	if m["passenger_msg"] != nil && !dataString(m["passenger_msg"], 512) {
		return false
	}
	if m["safety_mode_trigger_time"] != nil {
		n, ok := m["safety_mode_trigger_time"].(json.Number)
		if !ok {
			return false
		}
		f, err := n.Float64()
		if err != nil || f < 0 || f > 9e12 {
			return false
		}
	}
	for _, group := range []string{"components", "hmi_modules", "other_components"} {
		entries, ok := m[group].(map[string]any)
		if !ok || len(entries) > 64 {
			return false
		}
		for key, raw := range entries {
			if !telemetryIdentifier.MatchString(key) {
				return false
			}
			if raw == nil {
				continue
			}
			item, ok := raw.(map[string]any)
			if !ok {
				return false
			}
			if group == "components" {
				if !exactData(item, "summary", "process", "channel", "resource", "other", "module") {
					return false
				}
				for _, value := range item {
					if !validComponent(value) {
						return false
					}
				}
			} else if !validComponent(raw) {
				return false
			}
		}
	}
	return true
}
func validComponent(raw any) bool {
	if raw == nil {
		return true
	}
	v, ok := raw.(map[string]any)
	return ok && exactData(v, "status", "message") && dataStatus(v["status"]) && (v["message"] == nil || dataString(v["message"], 256))
}

func (api *DataAPI) health(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 65536)
	if !ok {
		return
	}
	if !validHealth(v, r.PathValue("vehicle_id")) {
		http.Error(w, "invalid health snapshot", 400)
		return
	}
	dataWriteResult(w, api.store.saveDataSnapshot(r.Context(), r.PathValue("vehicle_id"), "health", raw, v))
}

func (api *DataAPI) profile(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 8192)
	if !ok {
		return
	}
	if !exactData(v, "schema_version", "type", "vehicle_id", "stream_id", "sequence", "published_at_ms", "model", "software_version", "map_id", "task_mode") ||
		!dataInt(v["schema_version"], 1, 1) || v["type"] != "vehicle_profile" || v["vehicle_id"] != r.PathValue("vehicle_id") ||
		!dataID(v["stream_id"]) || !dataInt(v["sequence"], 1, maxTelemetryInteger) || !dataInt(v["published_at_ms"], 1, maxTelemetryInteger) ||
		!dataString(v["model"], 128) || !dataString(v["software_version"], 128) || !dataString(v["map_id"], 128) ||
		(v["task_mode"] != "disabled" && v["task_mode"] != "simulation" && v["task_mode"] != "mission_query") {
		http.Error(w, "invalid vehicle profile", 400)
		return
	}
	dataWriteResult(w, api.store.saveDataSnapshot(r.Context(), r.PathValue("vehicle_id"), "profile", raw, v))
}

func (api *DataAPI) event(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 4096)
	if !ok {
		return
	}
	if !exactData(v, "schema_version", "type", "vehicle_id", "event_id", "fault_key", "severity", "transition", "occurred_at_ms", "message") ||
		!dataInt(v["schema_version"], 1, 1) || v["type"] != "vehicle_event" || v["vehicle_id"] != r.PathValue("vehicle_id") ||
		!dataID(v["event_id"]) || !dataString(v["fault_key"], 256) || v["fault_key"] == "" ||
		!dataInt(v["occurred_at_ms"], 1, maxTelemetryInteger) || !dataString(v["message"], 512) ||
		(v["severity"] != "WARN" && v["severity"] != "ERROR" && v["severity"] != "FATAL" && v["severity"] != "OK") ||
		(v["transition"] != "raised" && v["transition"] != "changed" && v["transition"] != "recovered") ||
		((v["transition"] == "recovered") != (v["severity"] == "OK")) {
		http.Error(w, "invalid health event", 400)
		return
	}
	dataWriteResult(w, api.store.saveDataEvent(r.Context(), r.PathValue("vehicle_id"), raw, v["event_id"].(string)))
}

func (api *DataAPI) acknowledge(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "task") {
		return
	}
	_, body, ok := readDataJSON(w, r, 128)
	if !ok {
		return
	}
	id := r.PathValue("event_id")
	if !dataID(id) || len(body) != 0 {
		http.Error(w, "invalid event acknowledgement", 400)
		return
	}
	operator := r.Context().Value("user").(*UserClaims).Name
	err := api.store.acknowledgeDataEvent(r.Context(), r.PathValue("vehicle_id"), id, operator)
	if err == nil {
		recordAudit(r.Context(), AuditEvent{VehicleID: r.PathValue("vehicle_id"), OperatorID: operator, Event: "health_event_acknowledged", Result: "acknowledged_not_recovered"})
	}
	dataWriteResult(w, err)
}

func validDataTask(v map[string]any, vehicle string) bool {
	if !exactData(v, "schema_version", "vehicle_id", "request_id", "client_epoch", "operation", "created_at_ms", "expires_at_ms", "map_id", "parameters") ||
		!dataInt(v["schema_version"], 1, 1) || v["vehicle_id"] != vehicle || !dataID(v["request_id"]) || !dataID(v["client_epoch"]) ||
		!dataInt(v["created_at_ms"], 1, maxTelemetryInteger) || !dataInt(v["expires_at_ms"], 1, maxTelemetryInteger) || !dataString(v["map_id"], 128) {
		return false
	}
	created, _ := telemetryInteger(v["created_at_ms"], 1, maxTelemetryInteger)
	expires, _ := telemetryInteger(v["expires_at_ms"], 1, maxTelemetryInteger)
	if expires <= created || expires-created > 86400000 {
		return false
	}
	p, ok := v["parameters"].(map[string]any)
	if !ok || !exactData(p, "duration_ms", "target_request_id", "target_client_epoch") {
		return false
	}
	switch v["operation"] {
	case "simulate_wait":
		return dataInt(p["duration_ms"], 1, 60000) && p["target_request_id"] == nil && p["target_client_epoch"] == nil
	case "query":
		return dataInt(p["duration_ms"], 0, 0) && dataID(p["target_request_id"]) && dataID(p["target_client_epoch"])
	default:
		return false
	}
}

func (api *DataAPI) createTask(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "task") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 8192)
	if !ok {
		return
	}
	if !validDataTask(v, r.PathValue("vehicle_id")) {
		http.Error(w, "unsupported or invalid task", 400)
		return
	}
	// Physical mutations require a future approved task adapter and capability contract.
	// Only query and explicitly allowlisted simulator work are supported here.
	if v["operation"] == "simulate_wait" && !simulationControlEnabled(r.PathValue("vehicle_id")) {
		http.Error(w, "simulator task requires explicit vehicle allowlist", 403)
		return
	}
	err := api.store.createDataTask(r.Context(), r.PathValue("vehicle_id"), v["request_id"].(string), raw)
	if err != nil {
		dataWriteResult(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{VehicleID: r.PathValue("vehicle_id"), OperatorID: r.Context().Value("user").(*UserClaims).Name,
		Event: "data_task_created", Result: "persisted_not_executed"})
	w.WriteHeader(http.StatusAccepted)
}

func (api *DataAPI) nextTask(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	// Deliberately below the SDK's two-second HTTP timeout.
	timer := time.NewTimer(750 * time.Millisecond)
	defer timer.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		task, err := api.store.pendingDataTask(r.Context(), r.PathValue("vehicle_id"))
		if err != nil {
			dataWriteResult(w, err)
			return
		}
		if task != nil {
			writeJSON(w, 200, map[string]any{"task": task})
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-timer.C:
			writeJSON(w, 200, map[string]any{"task": nil})
			return
		case <-ticker.C:
		}
	}
}

func (api *DataAPI) taskResult(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "device") {
		return
	}
	raw, v, ok := readDataJSON(w, r, 8192)
	if !ok {
		return
	}
	if !exactData(v, "request_id", "report_sequence", "status", "reason", "mission_result") || !dataID(v["request_id"]) ||
		!dataInt(v["report_sequence"], 1, maxTelemetryInteger) ||
		!dataString(v["reason"], 512) || (v["status"] != "received" && v["status"] != "reconciling" && v["status"] != "succeeded" && v["status"] != "rejected" && v["status"] != "unknown") ||
		(v["mission_result"] != nil && !validMissionQueryResult(v["mission_result"])) {
		http.Error(w, "invalid task result", 400)
		return
	}
	dataWriteResult(w, api.store.saveTaskResult(r.Context(), r.PathValue("vehicle_id"), v["request_id"].(string), raw))
}
func validMissionQueryResult(raw any) bool {
	m, ok := raw.(map[string]any)
	if !ok || !exactData(m, "identity", "requested_mission_id", "outcome", "code", "reason",
		"durably_committed", "commit_sequence", "retry_disposition", "terminal_disposition",
		"affected_task_identity", "current_task_identity") {
		return false
	}
	identity, ok := m["identity"].(map[string]any)
	if !ok || !exactData(identity, "client_epoch", "request_id") || !dataID(identity["client_epoch"]) || !dataID(identity["request_id"]) {
		return false
	}
	for _, field := range []string{"requested_mission_id", "reason"} {
		if m[field] != nil && !dataString(m[field], 2048) {
			return false
		}
	}
	for _, field := range []string{"outcome", "code", "retry_disposition", "terminal_disposition"} {
		if m[field] != nil && !dataString(m[field], 64) {
			return false
		}
	}
	if !dataString(m["outcome"], 64) || !dataString(m["code"], 64) {
		return false
	}
	if m["durably_committed"] != nil {
		if _, ok := m["durably_committed"].(bool); !ok {
			return false
		}
	}
	if !dataUint64(m["commit_sequence"]) {
		return false
	}
	for _, field := range []string{"affected_task_identity", "current_task_identity"} {
		if m[field] == nil {
			continue
		}
		command, ok := m[field].(map[string]any)
		if !ok || !exactData(command, "producer_epoch", "aggregate_id", "command_id", "revision") || !dataUint64(command["revision"]) {
			return false
		}
		for _, name := range []string{"producer_epoch", "aggregate_id", "command_id"} {
			if command[name] != nil && !dataString(command[name], 128) {
				return false
			}
		}
	}
	return true
}
func dataUint64(raw any) bool {
	if raw == nil {
		return true
	}
	text, ok := raw.(string)
	if !ok {
		return false
	}
	value, err := strconv.ParseUint(text, 10, 64)
	return err == nil && strconv.FormatUint(value, 10) == text
}
func (api *DataAPI) get(w http.ResponseWriter, r *http.Request) {
	if !api.authorize(w, r, "observe") {
		return
	}
	value, err := api.store.dataView(r.Context(), r.PathValue("vehicle_id"))
	if err != nil {
		dataWriteResult(w, err)
		return
	}
	claims := r.Context().Value("user").(*UserClaims)
	value["can_manage"] = canControl(claims) && api.authorizer.Authorize(claims, r.PathValue("vehicle_id"), ControlPermission)
	writeJSON(w, 200, value)
}
func dataWriteResult(w http.ResponseWriter, err error) {
	switch {
	case err == nil:
		w.WriteHeader(204)
	case errors.Is(err, ErrOperationsConflict):
		http.Error(w, "data conflicts with retained identity", 409)
	case errors.Is(err, sql.ErrNoRows):
		http.Error(w, "task not found", 404)
	case errors.Is(err, errDataFull):
		http.Error(w, "durable data capacity exhausted; operator archival required", 507)
	case errors.Is(err, errDataExpired):
		http.Error(w, "task expired or future-created", 400)
	default:
		http.Error(w, "data store unavailable", 503)
	}
}
