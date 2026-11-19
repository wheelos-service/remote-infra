package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

func TestJSONAuditSink(t *testing.T) {
	var output bytes.Buffer
	sink := NewJSONAuditSink(&output)
	if err := sink.Record(context.Background(), AuditEvent{
		OperatorID: "operator-001", VehicleID: "vehicle-001", SessionID: "session-001",
		Event: "control_acquire", Result: "success",
	}); err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	var event AuditEvent
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if event.Timestamp.IsZero() || event.OperatorID != "operator-001" || event.Event != "control_acquire" || event.Result != "success" {
		t.Fatalf("Record() event = %#v", event)
	}
	if err := sink.Record(context.Background(), AuditEvent{Event: "control_acquire"}); err == nil {
		t.Fatal("Record() without result error = nil, want error")
	}
}