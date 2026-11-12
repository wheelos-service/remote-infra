package gateway

import "net/http"

func registerDeviceAuthCheck(mux *http.ServeMux) {
	mux.Handle("GET /api/vehicles/{vehicle_id}/device-auth-check",
		vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleDeviceAuthCheck))))
}

func handleDeviceAuthCheck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeDiagnosticError(w, r, "method not allowed", "METHOD_NOT_ALLOWED", http.StatusMethodNotAllowed)
		return
	}
	vehicleID := r.PathValue("vehicle_id")
	if vehicleRegistry == nil {
		writeDiagnosticError(w, r, "vehicle registry unavailable", "VEHICLE_REGISTRY_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	claims := r.Context().Value("user").(*UserClaims)
	if !vehicleSelfMatches(claims, vehicleID, vehicleIdentities) {
		writeDiagnosticError(w, r, "vehicle identity does not match registered vehicle", "VEHICLE_IDENTITY_MISMATCH", http.StatusForbidden)
		return
	}
	if _, registered := requestVehicleRegistry(r, vehicleRegistry).byID[vehicleID]; !registered {
		writeDiagnosticError(w, r, "vehicle is not registered", "VEHICLE_NOT_REGISTERED", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
