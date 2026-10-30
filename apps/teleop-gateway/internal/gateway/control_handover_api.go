package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
)

func registerControlHandover(mux *http.ServeMux) {
	mux.Handle("GET /api/vehicles/{vehicle_id}/control/handover",
		vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleGetHandover))))
	mux.Handle("POST /api/vehicles/{vehicle_id}/control/handover/ack",
		vehicleTelemetryNoStore(AuthenticationMiddleware(http.HandlerFunc(handleAcknowledgeHandover))))
}

func handleGetHandover(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !vehicleSelfMatches(claims, vehicleID, vehicleIdentities) &&
		(!canObserve(claims) || !vehicleAuthorizer.Authorize(claims, vehicleID, ObservePermission)) {
		http.Error(w, "forbidden: vehicle permission required", http.StatusForbidden)
		return
	}
	handover, err := controlLeases.GetHandover(r.Context(), vehicleID)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, handover)
}

func handleAcknowledgeHandover(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !vehicleSelfMatches(claims, vehicleID, vehicleIdentities) {
		http.Error(w, "forbidden: vehicle identity mismatch", http.StatusForbidden)
		return
	}
	// No generic stop/speed heuristic can prove an Apollo handover. This endpoint
	// stays disabled until the deployment's native policy is bench-validated.
	if os.Getenv("CONTROL_HANDOVER_ACK_ENABLED") != "true" {
		http.Error(w, "native handover policy has not been enabled", http.StatusServiceUnavailable)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	if err != nil || rejectDuplicateJSONFields(raw) != nil {
		http.Error(w, "invalid handover acknowledgement", http.StatusBadRequest)
		return
	}
	var fields map[string]json.RawMessage
	var ack struct {
		SessionID                string `json:"session_id"`
		Revision                 int64  `json:"revision"`
		EdgeRevocationApplied    bool   `json:"edge_revocation_applied"`
		VehicleHandoverConfirmed bool   `json:"vehicle_handover_confirmed"`
	}
	if json.Unmarshal(raw, &fields) != nil || len(fields) != 4 ||
		fields["session_id"] == nil || fields["revision"] == nil ||
		fields["edge_revocation_applied"] == nil || fields["vehicle_handover_confirmed"] == nil ||
		json.Unmarshal(raw, &ack) != nil || ack.SessionID == "" || len(ack.SessionID) > 128 ||
		ack.Revision <= 0 || ack.Revision > maxTelemetryInteger ||
		!ack.EdgeRevocationApplied {
		http.Error(w, "native revocation must be applied before reporting handover", http.StatusBadRequest)
		return
	}
	err = controlLeases.ReportHandover(r.Context(), vehicleID, ack.SessionID, ack.Revision, ack.VehicleHandoverConfirmed)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if !ack.VehicleHandoverConfirmed {
		handover, err := controlLeases.GetHandover(r.Context(), vehicleID)
		if err != nil {
			writeControlSessionError(w, err)
			return
		}
		recordAudit(r.Context(), AuditEvent{VehicleID: vehicleID, SessionID: ack.SessionID,
			Event: "control_revocation_applied", Result: "device_reported"})
		writeJSON(w, http.StatusAccepted, handover)
		return
	}
	recordAudit(r.Context(), AuditEvent{VehicleID: vehicleID, SessionID: ack.SessionID,
		Event: "control_handover_confirmed", Result: "device_reported"})
	w.WriteHeader(http.StatusNoContent)
}

func controlRequestOwner(r *http.Request, sessionID string) (ControlSession, error) {
	session, err := controlLeases.getSessionByID(r.Context(), sessionID)
	if err != nil {
		return session, err
	}
	claims := r.Context().Value("user").(*UserClaims)
	if session.OperatorID != claims.Name || session.OperatorTenant != claims.Organization ||
		!canControl(claims) || !vehicleAuthorizer.Authorize(claims, session.VehicleID, ControlPermission) {
		return ControlSession{}, ErrControlSessionOwner
	}
	return session, nil
}
