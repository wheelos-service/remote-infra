package gateway

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

var errReceiverUnavailable = errors.New("CONTROL_RECEIVER_UNAVAILABLE")

type acquireControlRequest struct {
	ContractVersion  int    `json:"contract_version"`
	PublicKeyB64     string `json:"public_key_b64"`
	ProtocolVersion  int    `json:"protocol_version"`
	ClientInstanceID string `json:"client_instance_id"`
}

type controlSessionResponse struct {
	Session      ControlSession       `json:"session"`
	Token        string               `json:"token,omitempty"`
	RenewAfterMS int64                `json:"renew_after_ms,omitempty"`
	ServerTimeMS int64                `json:"server_time_ms,omitempty"`
	TimingPolicy *ControlTimingPolicy `json:"timing_policy,omitempty"`
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
	raw, readErr := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024))
	var fields map[string]json.RawMessage
	if readErr != nil || rejectDuplicateJSONFields(raw) != nil ||
		json.Unmarshal(raw, &request) != nil || json.Unmarshal(raw, &fields) != nil ||
		fields["public_key_b64"] == nil ||
		!(len(fields) == 1 || ((len(fields) == 3 || len(fields) == 4 && request.ContractVersion == 3) && request.ProtocolVersion == 2 &&
			fields["client_instance_id"] != nil && telemetryIdentifier.MatchString(request.ClientInstanceID))) {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if !isEd25519PublicKey(request.PublicKeyB64) {
		http.Error(w, "invalid Ed25519 public key", http.StatusBadRequest)
		return
	}
	if claims.managed != nil && request.ProtocolVersion != 2 {
		http.Error(w, "managed control requires v2", http.StatusForbidden)
		return
	}
	native := request.ContractVersion == 3 && !simulationControlEnabled(vehicleID)
	if native && !nativeBenchEnabled(vehicleID) || !native && claims.managed != nil && !simulationControlEnabled(vehicleID) {
		writeDiagnosticError(w, r, "managed native control unavailable: handover support required", "MANAGED_NATIVE_HANDOVER_REQUIRED", http.StatusServiceUnavailable)
		return
	}
	now := time.Now()
	session := ControlSession{
		SessionID:      uuid.NewString(),
		VehicleID:      vehicleID,
		OperatorID:     claims.Name,
		OperatorTenant: claims.Organization,
		PublicKeyB64:   request.PublicKeyB64,
		Status:         ControlSessionActive,
		CreatedAtMS:    now.UnixMilli(),
		ExpiresAtMS:    now.Add(controlLeases.ttl).UnixMilli(),
	}
	if request.ProtocolVersion == 2 {
		session.ProtocolVersion = 2
		session.ClientInstanceID = request.ClientInstanceID
		session.SenderIdentity = "control-" + session.SessionID
	}
	if native {
		instance, err := controlLeases.client.Get(r.Context(), receiverKey(vehicleID)).Result()
		if err != nil || !nativeInstance.MatchString(instance) {
			writeDiagnosticError(w, r, errReceiverUnavailable.Error(), errReceiverUnavailable.Error(), 503)
			return
		}
		session.ContractVersion = 3
		session.ReceiverInstanceID = instance
	}
	if lkApiKey == "" || lkApiSecret == "" {
		http.Error(w, "control token configuration unavailable", http.StatusServiceUnavailable)
		return
	}
	token, err := issueControlToken(session)
	if err != nil {
		http.Error(w, "failed to issue LiveKit token", http.StatusInternalServerError)
		return
	}
	if !reserveManagedToken(w, r, token) {
		return
	}
	if err := controlLeases.AcquireControlSession(r.Context(), session); err != nil {
		writeControlSessionError(w, err)
		return
	}

	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_acquire", Result: "success",
	})
	policy := defaultControlTimingPolicy()
	writeJSON(w, http.StatusOK, controlSessionResponse{
		Session:      session,
		Token:        token,
		RenewAfterMS: controlLeases.ttl.Milliseconds() / 2,
		ServerTimeMS: now.UnixMilli(),
		TimingPolicy: &policy,
	})
}

func handleRenewControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	current, err := controlRequestOwner(r, r.PathValue("session_id"))
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if claims.managed != nil && current.ProtocolVersion != 2 {
		http.Error(w, "managed renewal requires v2", http.StatusForbidden)
		return
	}
	if current.ContractVersion == 3 && !nativeBenchEnabled(current.VehicleID) {
		writeControlSessionError(w, errReceiverUnavailable)
		return
	}
	session, err := controlLeases.RenewControlSession(r.Context(), r.PathValue("session_id"), claims.Name)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_renew", Result: "success",
	})
	policy := defaultControlTimingPolicy()
	writeJSON(w, http.StatusOK, controlSessionResponse{
		Session:      session,
		RenewAfterMS: controlLeases.ttl.Milliseconds() / 2,
		ServerTimeMS: time.Now().UnixMilli(),
		TimingPolicy: &policy,
	})
}

func handleReleaseControl(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	session, err := controlRequestOwner(r, r.PathValue("session_id"))
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	if err := controlLeases.ReleaseControlSession(r.Context(), session.SessionID, claims.Name); err != nil {
		writeControlSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		OperatorID: session.OperatorID, VehicleID: session.VehicleID, SessionID: session.SessionID,
		Event: "control_release", Result: "success",
	})
	// Releasing the HTTP lease starts handover; it does not confirm the vehicle.
	handover, err := controlLeases.GetHandover(r.Context(), session.VehicleID)
	if err != nil {
		writeControlSessionError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, handover)
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
	resolvedVehicleID, registered := resolveVehicleClaims(claims, identities)
	return (registered && resolvedVehicleID == vehicleID) ||
		(!identities.Strict() && claims.Name == vehicleID)
}

func isEd25519PublicKey(encoded string) bool {
	key, err := base64.StdEncoding.DecodeString(encoded)
	return err == nil && len(key) == 32
}

func writeControlSessionError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errReceiverUnavailable):
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
	case errors.Is(err, ErrControlLeaseHeld), errors.Is(err, ErrControlHandoverPending):
		http.Error(w, err.Error(), http.StatusConflict)
	case errors.Is(err, ErrControlSessionNotFound):
		http.Error(w, err.Error(), http.StatusNotFound)
	case errors.Is(err, ErrControlSessionOwner):
		http.Error(w, err.Error(), http.StatusForbidden)
	default:
		teleopGateway503Total.WithLabelValues("CONTROL_SESSION_UNAVAILABLE").Inc()
		http.Error(w, "control session unavailable", http.StatusServiceUnavailable)
	}
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
