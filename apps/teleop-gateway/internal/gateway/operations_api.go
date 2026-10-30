package gateway

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"time"
	"unicode/utf8"
)

func operationsFileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func operationsJSONEqual(a, b []byte) bool {
	var left, right any
	first, second := json.NewDecoder(bytes.NewReader(a)), json.NewDecoder(bytes.NewReader(b))
	first.UseNumber()
	second.UseNumber()
	return first.Decode(&left) == nil && second.Decode(&right) == nil && reflect.DeepEqual(left, right)
}

type OperationsIssue struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
}

type OperationsDiagnostics struct {
	Source               string            `json:"source"`
	ChassisReceived      bool              `json:"chassis_received"`
	LocalizationReceived bool              `json:"localization_received"`
	ChassisAgeMS         *int64            `json:"chassis_age_ms"`
	LocalizationAgeMS    *int64            `json:"localization_age_ms"`
	SourceTimestampMS    *int64            `json:"source_timestamp_ms"`
	Issues               []OperationsIssue `json:"issues"`
}

type OperationsAlert struct {
	EventID      string `json:"event_id"`
	OccurredAtMS int64  `json:"occurred_at_ms"`
	Severity     string `json:"severity"`
	Code         string `json:"code"`
	Message      string `json:"message"`
	Status       string `json:"status"`
	ResolvedAtMS *int64 `json:"resolved_at_ms"`
}

type OperationsHistory struct {
	StreamID      string          `json:"stream_id"`
	Sequence      int64           `json:"sequence"`
	PublishedAtMS int64           `json:"published_at_ms"`
	ReceivedAtMS  int64           `json:"received_at_ms"`
	Chassis       json.RawMessage `json:"chassis"`
	Localization  json.RawMessage `json:"localization"`
}

type OperationsCapabilities struct {
	MissionCommands      bool `json:"mission_commands"`
	GeographicProjection bool `json:"geographic_projection"`
	Driving              bool `json:"driving"`
}

type OperationsResponse struct {
	VehicleID    string                 `json:"vehicle_id"`
	ServerTimeMS int64                  `json:"server_time_ms"`
	Diagnostics  OperationsDiagnostics  `json:"diagnostics"`
	Alerts       []OperationsAlert      `json:"alerts"`
	Missions     []OperationsMission    `json:"missions"`
	History      []OperationsHistory    `json:"history"`
	Capabilities OperationsCapabilities `json:"capabilities"`
}

type OperationsAPI struct {
	registry   *VehicleRegistry
	authorizer *VehicleAuthorizer
	identities *VehicleIdentityResolver
	states     *VehicleTelemetryStore
	store      *OperationsStore
	now        func() time.Time
}

func NewOperationsAPI(store *OperationsStore, registry *VehicleRegistry, states *VehicleTelemetryStore,
	authorizer *VehicleAuthorizer, identities *VehicleIdentityResolver, now func() time.Time) *OperationsAPI {
	if now == nil {
		now = time.Now
	}
	return &OperationsAPI{store: store, registry: registry, states: states,
		authorizer: authorizer, identities: identities, now: now}
}

func (api *OperationsAPI) register(mux *http.ServeMux) {
	mux.Handle("GET /api/vehicles/{vehicle_id}/operations", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(api.get))))
	mux.Handle("POST /api/vehicles/{vehicle_id}/mission-status", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(api.postMission))))
}

func (api *OperationsAPI) get(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !canObserve(claims) || !api.authorizer.Authorize(claims, vehicleID, ObservePermission) {
		http.Error(w, "forbidden: vehicle observe permission required", http.StatusForbidden)
		return
	}
	if _, ok := api.registry.byID[vehicleID]; !ok {
		http.Error(w, "vehicle not registered", http.StatusNotFound)
		return
	}
	state, received, err := api.states.Get(r.Context(), vehicleID)
	if err != nil {
		http.Error(w, "vehicle state store unavailable", http.StatusServiceUnavailable)
		return
	}
	now := time.Now()
	if api.now != nil {
		now = api.now()
	}
	response, err := api.store.Snapshot(r.Context(), vehicleID)
	if err != nil {
		http.Error(w, "operations store unavailable", http.StatusServiceUnavailable)
		return
	}
	response.ServerTimeMS = now.UnixMilli()
	response.Diagnostics = deriveOperationsDiagnostics(state, received, now.UnixMilli())
	writeJSON(w, http.StatusOK, response)
}

func (api *OperationsAPI) postMission(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !vehicleSelfMatches(claims, vehicleID, api.identities) {
		http.Error(w, "forbidden: vehicle identity mismatch", http.StatusForbidden)
		return
	}
	if _, ok := api.registry.byID[vehicleID]; !ok {
		http.Error(w, "vehicle not registered", http.StatusNotFound)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 8192))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "mission status exceeds 8 KiB", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "invalid mission status body", http.StatusBadRequest)
		}
		return
	}
	mission, err := validateOperationsMission(raw)
	if err != nil {
		http.Error(w, "invalid mission status", http.StatusBadRequest)
		return
	}
	if err := api.store.RecordMission(r.Context(), vehicleID, mission); err != nil {
		if errors.Is(err, ErrOperationsConflict) || errors.Is(err, ErrMissionOutdated) {
			http.Error(w, err.Error(), http.StatusConflict)
		} else {
			http.Error(w, "operations store unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validOperationsMission(m OperationsMission) bool {
	if !telemetryIdentifier.MatchString(m.MissionID) || m.UpdatedAtMS <= 0 ||
		m.UpdatedAtMS > maxTelemetryInteger || !utf8.ValidString(m.Description) || len(m.Description) > 2048 {
		return false
	}
	switch m.Status {
	case "unknown", "accepted", "running", "succeeded", "failed", "canceled":
		return true
	default:
		return false
	}
}

func validateOperationsMission(raw []byte) (OperationsMission, error) {
	var mission OperationsMission
	if !utf8.Valid(raw) || rejectDuplicateJSONFields(raw) != nil {
		return mission, errors.New("invalid mission JSON")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return mission, err
	}
	obj, err := telemetryObject(value, "mission_id", "status", "updated_at_ms", "description")
	if err != nil || len(obj) != 4 {
		return mission, errors.New("mission requires exactly four fields")
	}
	id, idOK := obj["mission_id"].(string)
	status, statusOK := obj["status"].(string)
	description, descriptionOK := obj["description"].(string)
	updated, updatedOK := telemetryInteger(obj["updated_at_ms"], 1, maxTelemetryInteger)
	if !idOK || !statusOK || !descriptionOK || !updatedOK {
		return mission, errors.New("invalid mission fields")
	}
	mission = OperationsMission{MissionID: id, Status: status, UpdatedAtMS: updated, Description: description}
	if !validOperationsMission(mission) {
		return mission, errors.New("invalid mission fields")
	}
	return mission, nil
}

// Snapshot returns bounded persistent data: newest-first history/missions,
// open alerts first, then newest-first. It does not derive diagnostics from
// history: the API always uses Redis's actual latest sample.
func (s *OperationsStore) Snapshot(ctx context.Context, vehicleID string) (OperationsResponse, error) {
	response := OperationsResponse{VehicleID: vehicleID, Alerts: []OperationsAlert{},
		Missions: []OperationsMission{}, History: []OperationsHistory{}}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return response, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT stream_id,sequence,published_at_ms,received_at_ms,payload FROM operations_history
 WHERE vehicle_id=? ORDER BY received_at_ms DESC,id DESC LIMIT ?`, vehicleID, OperationsHistoryLimit)
	if err != nil {
		return response, err
	}
	for rows.Next() {
		var entry OperationsHistory
		var payload []byte
		if err := rows.Scan(&entry.StreamID, &entry.Sequence, &entry.PublishedAtMS, &entry.ReceivedAtMS, &payload); err != nil {
			rows.Close()
			return response, err
		}
		var state operationsTelemetry
		validated, err := validateVehicleTelemetry(payload)
		if err != nil || len(payload) > maxVehicleTelemetryBytes ||
			validated.VehicleID != vehicleID || validated.StreamID != entry.StreamID || validated.Sequence != entry.Sequence ||
			entry.ReceivedAtMS <= 0 || entry.ReceivedAtMS > maxTelemetryInteger {
			rows.Close()
			return response, errors.New("invalid stored operations telemetry")
		}
		if err := state.decode(payload); err != nil {
			rows.Close()
			return response, err
		}
		if state.PublishedAtMS != entry.PublishedAtMS {
			rows.Close()
			return response, errors.New("stored operations publication timestamp mismatch")
		}
		entry.Chassis, entry.Localization = state.Chassis.Message, state.Localization.Message
		response.History = append(response.History, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return response, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT event_id,occurred_at_ms,severity,code,message,status,resolved_at_ms FROM operations_alerts
 WHERE vehicle_id=? ORDER BY (status='open') DESC,occurred_at_ms DESC,id DESC LIMIT ?`, vehicleID, OperationsAlertLimit)
	if err != nil {
		return response, err
	}
	for rows.Next() {
		var entry OperationsAlert
		if err := rows.Scan(&entry.EventID, &entry.OccurredAtMS, &entry.Severity, &entry.Code, &entry.Message, &entry.Status, &entry.ResolvedAtMS); err != nil {
			rows.Close()
			return response, err
		}
		if !validOperationsAlert(entry) {
			rows.Close()
			return response, errors.New("invalid stored operations alert")
		}
		response.Alerts = append(response.Alerts, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return response, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT mission_id,status,updated_at_ms,description FROM operations_missions
 WHERE vehicle_id=? ORDER BY updated_at_ms DESC,mission_id LIMIT ?`, vehicleID, OperationsMissionLimit)
	if err != nil {
		return response, err
	}
	for rows.Next() {
		var entry OperationsMission
		if err := rows.Scan(&entry.MissionID, &entry.Status, &entry.UpdatedAtMS, &entry.Description); err != nil {
			rows.Close()
			return response, err
		}
		if !validOperationsMission(entry) {
			rows.Close()
			return response, errors.New("invalid stored operations mission")
		}
		response.Missions = append(response.Missions, entry)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return response, err
	}
	return response, tx.Commit()
}

func validOperationsAlert(alert OperationsAlert) bool {
	id, err := hex.DecodeString(alert.EventID)
	if err != nil || len(id) != 32 || alert.OccurredAtMS <= 0 || alert.OccurredAtMS > maxTelemetryInteger ||
		len(alert.Code) == 0 || len(alert.Code) > 128 || len(alert.Message) == 0 || len(alert.Message) > 2048 ||
		!utf8.ValidString(alert.Message) {
		return false
	}
	if alert.Severity != "info" && alert.Severity != "warning" && alert.Severity != "critical" {
		return false
	}
	if alert.Status == "open" {
		return alert.ResolvedAtMS == nil
	}
	return alert.Status == "resolved" && alert.ResolvedAtMS != nil &&
		*alert.ResolvedAtMS >= alert.OccurredAtMS && *alert.ResolvedAtMS <= maxTelemetryInteger
}

// Age is conservative: max(callback age + publication/network/receipt delay,
// source timestamp age). All clocks must be non-future and both source timing
// fields must be present. Unknown or invalid timing stays null, never "healthy".
func operationsSampleAge(sample operationsSample, published, received, now int64) (*int64, bool) {
	clock := received > now || published > received ||
		(sample.SourceTimestampMS != nil && (*sample.SourceTimestampMS > published || *sample.SourceTimestampMS > now))
	if !sample.received() || sample.AgeMS == nil || sample.SourceTimestampMS == nil || clock {
		return nil, clock
	}
	age := *sample.AgeMS + (now - published)
	sourceAge := now - *sample.SourceTimestampMS
	if sourceAge > age {
		age = sourceAge
	}
	// Saturate extreme valid source ages at the JSON safe-integer boundary.
	if age > maxTelemetryInteger {
		age = maxTelemetryInteger
	}
	return &age, false
}

func deriveOperationsDiagnostics(raw json.RawMessage, received *int64, now int64) OperationsDiagnostics {
	result := OperationsDiagnostics{Source: "telemetry", Issues: []OperationsIssue{}}
	var state operationsTelemetry
	if len(raw) != 0 {
		_ = state.decode(raw)
	}
	receipt := now
	if received != nil {
		receipt = *received
	}
	result.ChassisReceived, result.LocalizationReceived = state.Chassis.received(), state.Localization.received()
	// The scalar timestamp describes chassis if present, otherwise localization.
	// Individual history entries preserve each sample's message, not guessed geo.
	if result.ChassisReceived {
		result.SourceTimestampMS = state.Chassis.SourceTimestampMS
	} else if result.LocalizationReceived {
		result.SourceTimestampMS = state.Localization.SourceTimestampMS
	}
	for _, item := range []struct {
		name   string
		sample operationsSample
		age    **int64
	}{
		{"chassis", state.Chassis, &result.ChassisAgeMS},
		{"localization", state.Localization, &result.LocalizationAgeMS},
	} {
		add := func(suffix, message string) {
			result.Issues = append(result.Issues, OperationsIssue{Code: item.name + "_" + suffix, Severity: "warning", Message: message})
		}
		if !item.sample.received() {
			add("missing", item.name+" sample has not been received")
			continue
		}
		age, clock := operationsSampleAge(item.sample, state.PublishedAtMS, receipt, now)
		*item.age = age
		if clock {
			add("clock", item.name+" timing is in the future or clocks disagree")
		} else if age == nil || received == nil {
			*item.age = nil
			add("timing_missing", item.name+" source freshness is unknown")
		} else if *age > OperationsFreshnessMS {
			add("stale", item.name+" sample is stale")
		}
	}
	if result.ChassisReceived {
		if code := state.Chassis.errorCode(); code != nil && *code != 0 {
			result.Issues = append(result.Issues, OperationsIssue{Code: "chassis_error", Severity: "critical",
				Message: "Chassis reported a nonzero error code; native SystemStatus is not available"})
		}
	}
	return result
}
