package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const maxVehicleTelemetryBytes = 64 * 1024

type vehicleControlSummary struct {
	Status string `json:"status"`
	IsSelf bool   `json:"is_self"`
}

type vehicleStateResponse struct {
	VehicleID    string                `json:"vehicle_id"`
	Name         string                `json:"name"`
	State        json.RawMessage       `json:"state"`
	ReceivedAtMS *int64                `json:"received_at_ms"`
	ServerTimeMS int64                 `json:"server_time_ms"`
	Online       bool                  `json:"online"`
	Control      vehicleControlSummary `json:"control"`
}

type VehicleTelemetryAPI struct {
	registry   *VehicleRegistry
	states     *VehicleTelemetryStore
	leases     *ControlLeaseStore
	authorizer *VehicleAuthorizer
	identities *VehicleIdentityResolver
	operations *OperationsStore
}

func (api *VehicleTelemetryAPI) register(mux *http.ServeMux) {
	mux.Handle("GET /api/vehicles", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(api.list))))
	mux.Handle("GET /api/vehicles/{vehicle_id}/state", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(api.get))))
	mux.Handle("POST /api/vehicles/{vehicle_id}/state", vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(api.post))))
}

func vehicleTelemetryNoStore(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func (api *VehicleTelemetryAPI) post(w http.ResponseWriter, r *http.Request) {
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
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxVehicleTelemetryBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "telemetry exceeds 64 KiB", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "invalid telemetry body", http.StatusBadRequest)
		}
		return
	}
	state, err := validateVehicleTelemetry(raw)
	if err != nil {
		http.Error(w, "invalid vehicle telemetry", http.StatusBadRequest)
		return
	}
	if state.VehicleID != vehicleID {
		http.Error(w, "forbidden: payload vehicle identity mismatch", http.StatusForbidden)
		return
	}
	received, saveErr := api.states.SaveAt(r.Context(), state)
	if errors.Is(saveErr, errTelemetryConflict) && api.operations != nil {
		current, originalReceipt, getErr := api.states.Get(r.Context(), vehicleID)
		if getErr != nil {
			http.Error(w, "vehicle state store unavailable", http.StatusServiceUnavailable)
			return
		}
		if originalReceipt != nil && bytes.Equal(current, state.Payload) {
			exists, err := api.operations.HasTelemetry(r.Context(), vehicleID, state.StreamID, state.Sequence)
			if err != nil {
				http.Error(w, "operations store unavailable", http.StatusServiceUnavailable)
				return
			}
			if !exists {
				// Retry only a partially archived current snapshot, without refreshing
				// its Redis receipt or weakening the replay fence.
				received, saveErr = *originalReceipt, nil
			}
		}
	}
	if saveErr != nil {
		if errors.Is(saveErr, errTelemetryConflict) {
			http.Error(w, saveErr.Error(), http.StatusConflict)
		} else {
			http.Error(w, "vehicle state store unavailable", http.StatusServiceUnavailable)
		}
		return
	}
	if api.operations != nil {
		if err := api.operations.RecordTelemetry(r.Context(), state, received); err != nil {
			http.Error(w, "operations archive unavailable; latest state may already be accepted", http.StatusServiceUnavailable)
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

func (api *VehicleTelemetryAPI) list(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	if !canObserve(claims) {
		http.Error(w, "forbidden: observer role required", http.StatusForbidden)
		return
	}
	response := struct {
		Vehicles []vehicleStateResponse `json:"vehicles"`
	}{Vehicles: make([]vehicleStateResponse, 0)}
	now := api.states.now()
	for _, vehicle := range api.registry.vehicles {
		if !api.authorizer.Authorize(claims, vehicle.VehicleID, ObservePermission) {
			continue
		}
		entry, err := api.entry(r, vehicle, now)
		if err != nil {
			http.Error(w, "vehicle state or control store unavailable", http.StatusServiceUnavailable)
			return
		}
		response.Vehicles = append(response.Vehicles, entry)
	}
	writeJSON(w, http.StatusOK, response)
}

func (api *VehicleTelemetryAPI) get(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !canObserve(claims) || !api.authorizer.Authorize(claims, vehicleID, ObservePermission) {
		http.Error(w, "forbidden: vehicle observe permission required", http.StatusForbidden)
		return
	}
	vehicle, ok := api.registry.byID[vehicleID]
	if !ok {
		http.Error(w, "vehicle not registered", http.StatusNotFound)
		return
	}
	entry, err := api.entry(r, vehicle, api.states.now())
	if err != nil {
		http.Error(w, "vehicle state or control store unavailable", http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (api *VehicleTelemetryAPI) entry(r *http.Request, vehicle RegisteredVehicle, now time.Time) (vehicleStateResponse, error) {
	entry := vehicleStateResponse{
		VehicleID: vehicle.VehicleID, Name: vehicle.Name, ServerTimeMS: now.UnixMilli(),
		Control: vehicleControlSummary{Status: "unknown"},
	}
	state, received, err := api.states.Get(r.Context(), vehicle.VehicleID)
	if err != nil {
		return entry, err
	}
	entry.State, entry.ReceivedAtMS = state, received
	if received != nil {
		age := now.UnixMilli() - *received
		entry.Online = age >= 0 && age <= vehicleOnlineWindow.Milliseconds()
	}
	if api.leases == nil {
		return entry, nil
	}
	raw, err := api.leases.client.Get(r.Context(), controlLeaseKey(vehicle.VehicleID)).Bytes()
	if errors.Is(err, redis.Nil) {
		handover, handoverErr := api.leases.GetHandover(r.Context(), vehicle.VehicleID)
		if handoverErr != nil {
			return entry, handoverErr
		}
		if handover.State == "ACTIVE" || handover.State == "PENDING" {
			// A missing lease is not proof of physical vehicle handover.
			return entry, nil
		}
		entry.Control.Status = "free"
		return entry, nil
	}
	if err != nil {
		return entry, err
	}
	var session ControlSession
	if err := json.Unmarshal(raw, &session); err != nil {
		// Older lease values contain only an operator ID, not a session DTO.
		// They are not proof that control is free or owned by this caller.
		return entry, nil
	}
	if session.VehicleID != vehicle.VehicleID || session.SessionID == "" || session.OperatorID == "" ||
		session.Status != ControlSessionActive || session.ExpiresAtMS <= now.UnixMilli() {
		return entry, nil
	}
	entry.Control.Status = "occupied"
	claims := r.Context().Value("user").(*UserClaims)
	entry.Control.IsSelf = session.OperatorID == claims.Name && session.OperatorTenant == claims.Organization
	return entry, nil
}
