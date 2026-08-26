package gateway

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
)

type acquireControlRequest struct {
	PublicKeyB64 string `json:"public_key_b64"`
}

type controlSessionResponse struct {
	Session      ControlSession `json:"session"`
	Token        string         `json:"token,omitempty"`
	RenewAfterMS int64          `json:"renew_after_ms,omitempty"`
}

func handleAcquireControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	if !canControl(claims) {
		http.Error(w, "forbidden: controller role required", http.StatusForbidden)
		return
	}
	vehicleID := r.PathValue("vehicle_id")
	if vehicleID == "" {
		http.Error(w, "missing vehicle id", http.StatusBadRequest)
		return
	}
	if !vehicleAuthorizer.Authorize(claims, vehicleID, ControlPermission) {
		http.Error(w, "forbidden: vehicle ACL denied", http.StatusForbidden)
		return
	}

	var request acquireControlRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if !isEd25519PublicKey(request.PublicKeyB64) {
		http.Error(w, "invalid Ed25519 public key", http.StatusBadRequest)
		return
	}

	now := time.Now()
	session := ControlSession{
		SessionID:    uuid.NewString(),
		VehicleID:    vehicleID,
		OperatorID:   claims.Name,
		PublicKeyB64: request.PublicKeyB64,
		Status:       ControlSessionActive,
		CreatedAtMS:  now.UnixMilli(),
		ExpiresAtMS:  now.Add(controlLeases.ttl).UnixMilli(),
	}
	if err := controlLeases.AcquireControlSession(r.Context(), session); err != nil {
		writeControlSessionError(w, err)
		return
	}
	if _, err := videoSessions.SetController(r.Context(), vehicleID, session.SessionID); err != nil {
		_ = controlLeases.ReleaseControlSession(r.Context(), session.SessionID, session.OperatorID)
		http.Error(w, "video session unavailable", http.StatusServiceUnavailable)
		return
	}

	token, err := issueOperatorToken(session.VehicleID, session.OperatorID, ControllerAccess)
	if err != nil {
		_ = controlLeases.ReleaseControlSession(r.Context(), session.SessionID, session.OperatorID)
		http.Error(w, "failed to issue LiveKit token", http.StatusInternalServerError)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_acquire", Result: "success",
	})
	writeJSON(w, http.StatusOK, controlSessionResponse{
		Session:      session,
		Token:        token,
		RenewAfterMS: controlLeases.ttl.Milliseconds() / 2,
	})
}

func handleRenewControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	session, err := controlLeases.RenewControlSession(r.Context(), r.PathValue("session_id"), claims.Name)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_renew", Result: "success",
	})
	writeJSON(w, http.StatusOK, controlSessionResponse{
		Session:      session,
		RenewAfterMS: controlLeases.ttl.Milliseconds() / 2,
	})
}

func handleReleaseControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	session, err := controlLeases.getSessionByID(r.Context(), r.PathValue("session_id"))
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if err := controlLeases.ReleaseControlSession(r.Context(), session.SessionID, claims.Name); err != nil {
		writeControlSessionError(w, err)
		return
	}
	if _, err := videoSessions.ClearController(r.Context(), session.VehicleID, session.SessionID); err != nil {
		http.Error(w, "video session unavailable", http.StatusServiceUnavailable)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_release", Result: "success",
	})
	w.WriteHeader(http.StatusNoContent)
}

func handleGetControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	isVehicleSelf := vehicleSelfMatches(claims, vehicleID, vehicleIdentities)
	if !isVehicleSelf && (!canObserve(claims) || !vehicleAuthorizer.Authorize(claims, vehicleID, ObservePermission)) {
		http.Error(w, "forbidden: vehicle or observer role required", http.StatusForbidden)
		return
	}

	session, err := controlLeases.GetControlSession(r.Context(), vehicleID)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, controlSessionResponse{Session: session})
}

func vehicleSelfMatches(claims *UserClaims, vehicleID string, identities *VehicleIdentityResolver) bool {
	if claims == nil || identities == nil || !hasRole(claims.Roles, "vehicle") {
		return false
	}
	resolvedVehicleID, registered := identities.Resolve(claims.Name)
	return (registered && resolvedVehicleID == vehicleID) ||
		(!identities.Strict() && claims.Name == vehicleID)
}

func isEd25519PublicKey(encoded string) bool {
	key, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && len(key) == 32
}

func writeControlSessionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrControlLeaseHeld):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, ErrControlSessionNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, ErrControlSessionOwner):
		http.Error(w, err.Error(), http.StatusForbidden)
	default:
		http.Error(w, "control session unavailable", http.StatusServiceUnavailable)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
