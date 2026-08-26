package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type AuditEvent struct {
	Timestamp  time.Time `json:"timestamp"`
	OperatorID string    `json:"operator_id,omitempty"`
	VehicleID  string    `json:"vehicle_id,omitempty"`
	SessionID  string    `json:"session_id,omitempty"`
	Event      string    `json:"event"`
	Reason     string    `json:"reason,omitempty"`
	Result     string    `json:"result"`
}

type AuditSink interface {
	Record(context.Context, AuditEvent) error
}

type JSONAuditSink struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func NewJSONAuditSink(writer io.Writer) *JSONAuditSink {
	return &JSONAuditSink{encoder: json.NewEncoder(writer)}
}

func (s *JSONAuditSink) Record(_ context.Context, event AuditEvent) error {
	if event.Event == "" || event.Result == "" {
		return fmt.Errorf("audit event and result are required")
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now().UTC()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.encoder.Encode(event)
}

type vehicleAuditRequest struct {
	SessionID string `json:"session_id"`
	Event     string `json:"event"`
	Reason    string `json:"reason"`
}

func handleVehicleAudit(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	claims := r.Context().Value("user").(*UserClaims)
	if !hasRole(claims.Roles, "vehicle") {
		http.Error(w, "forbidden: vehicle role required", http.StatusForbidden)
		return
	}
	var request vehicleAuditRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 16<<10)).Decode(&request); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}
	if !vehicleSafetyAuditEvent(request.Event) || request.Reason == "" {
		http.Error(w, "invalid vehicle audit event", http.StatusBadRequest)
		return
	}
	recordAudit(r.Context(), AuditEvent{
		VehicleID: claims.Name, SessionID: request.SessionID, Event: request.Event,
		Reason: request.Reason, Result: "reported",
	})
	w.WriteHeader(http.StatusNoContent)
}

func vehicleSafetyAuditEvent(event string) bool {
	switch event {
	case "watchdog_timeout", "command_rejected", "emergency_stop":
		return true
	default:
		return false
	}
}