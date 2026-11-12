package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestDataOperationsDiagnosticsAndCapacity(t *testing.T) {
	f, store := dataFixture(t)
	base := "/api/vehicles/car-2/data"
	packet := `{"schema_version":1,"type":"vehicle_data_diagnostics","vehicle_id":"car-2","stream_id":"boot-1","sequence":1,"published_at_ms":1,"store":{"capacity":10000,"outbox_retained":9000,"outbox_pending":20,"inbox_retained":10,"inbox_pending":1,"faults_retained":2}}`
	f.request(t, http.MethodPost, base+"/diagnostics", "device1", packet, 403)
	f.request(t, http.MethodPost, base+"/diagnostics", "device2", packet, 204)
	f.request(t, http.MethodPost, base+"/diagnostics", "device2", packet, 204)
	for _, invalid := range []string{
		strings.Replace(packet, `"outbox_pending":20`, `"outbox_pending":9001`, 1),
		strings.Replace(packet, `"inbox_pending":1`, `"inbox_pending":11`, 1),
		strings.Replace(packet, `"capacity":10000`, `"capacity":0`, 1),
		strings.Replace(packet, `"faults_retained":2`, `"faults_retained":10001`, 1),
	} {
		f.request(t, http.MethodPost, base+"/diagnostics", "device2", invalid, 400)
	}
	view := f.request(t, http.MethodGet, base, "controller", "", 200)
	var parsed map[string]any
	if err := json.Unmarshal(view.Body.Bytes(), &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed["can_manage"] != true || parsed["diagnostics"] == nil {
		t.Fatal("management permission or diagnostics missing")
	}
	view = f.request(t, http.MethodGet, base, "observer", "", 200)
	if !strings.Contains(view.Body.String(), `"can_manage":false`) {
		t.Fatal("observer received management permission")
	}
	f.request(t, http.MethodGet, base, "wrongtenant", "", 403)
	if _, err := store.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<8000)
 INSERT INTO data_events(vehicle_id,event_id,payload,received_at_ms) SELECT 'car-2','event-'||i,'{}',1 FROM n`); err != nil {
		t.Fatal(err)
	}
	stats, err := store.dataCapacity(context.Background(), "car-2")
	if err != nil || stats["capacity_warning"] != true || stats["events_unacknowledged"] != 8000 {
		t.Fatalf("capacity alarm missing: %v %v", stats, err)
	}
	stats, err = store.dataCapacity(context.Background(), "car-1")
	if err != nil || stats["events_retained"] != 0 {
		t.Fatal("capacity crossed vehicle boundary", err)
	}
}

func TestDataViewAcknowledgementsMatchVisibleEvents(t *testing.T) {
	f, store := dataFixture(t)
	for i := 1; i <= 101; i++ {
		id := fmt.Sprintf("event-%d", i)
		raw := []byte(fmt.Sprintf(`{"schema_version":1,"type":"vehicle_event","vehicle_id":"car-2","event_id":%q,"fault_key":"monitor","severity":"ERROR","transition":"raised","occurred_at_ms":1,"message":"test"}`, id))
		if err := store.saveDataEvent(context.Background(), "car-2", raw, id); err != nil {
			t.Fatal(err)
		}
		// The newest visible event has the oldest acknowledgement.
		if _, err := store.db.Exec(`INSERT INTO data_event_acknowledgements
 (vehicle_id,event_id,operator_id,acknowledged_at_ms) VALUES('car-2',?,'alice',?)`, id, 102-i); err != nil {
			t.Fatal(err)
		}
	}
	response := f.request(t, http.MethodGet, "/api/vehicles/car-2/data", "observer", "", 200)
	var view struct {
		Events []struct {
			ID string `json:"event_id"`
		} `json:"events"`
		Acknowledgements []struct {
			ID string `json:"event_id"`
		} `json:"acknowledgements"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatal(err)
	}
	if len(view.Events) != 100 || len(view.Acknowledgements) != 100 {
		t.Fatalf("unexpected visible counts: %d / %d", len(view.Events), len(view.Acknowledgements))
	}
	acknowledged := map[string]bool{}
	for _, ack := range view.Acknowledgements {
		acknowledged[ack.ID] = true
	}
	for _, event := range view.Events {
		if !acknowledged[event.ID] {
			t.Fatalf("visible event %s falsely appears unacknowledged", event.ID)
		}
	}
}

func TestDataRecordExportPaginationAndIsolation(t *testing.T) {
	f, store := dataFixture(t)
	base := "/api/vehicles/car-2/data"
	for i := 1; i <= 102; i++ {
		raw := fmt.Sprintf(`{"schema_version":1,"type":"vehicle_event","vehicle_id":"car-2","event_id":"event-%d","fault_key":"monitor","severity":"ERROR","transition":"raised","occurred_at_ms":1,"message":"test"}`, i)
		f.request(t, http.MethodPost, base+"/events", "device2", raw, 204)
	}
	f.request(t, http.MethodPost, base+"/events/event-1/acknowledge", "controller", `{}`, 204)
	var first struct {
		Through int64            `json:"through"`
		Next    int64            `json:"next"`
		HasMore bool             `json:"has_more"`
		Records []map[string]any `json:"records"`
	}
	response := f.request(t, http.MethodGet, base+"/records?kind=events", "observer", "", 200)
	if err := json.Unmarshal(response.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if first.Through != 102 || first.Next != 100 || !first.HasMore || len(first.Records) != 100 ||
		first.Records[0]["acknowledgement"] == nil {
		t.Fatalf("bad initial export: %+v", first)
	}
	// A new event must not extend an existing export's upper cursor.
	raw := []byte(`{"event_id":"late-event"}`)
	if err := store.saveDataEvent(context.Background(), "car-2", raw, "late-event"); err != nil {
		t.Fatal(err)
	}
	response = f.request(t, http.MethodGet, base+"/records?kind=events&after=100&through=102", "observer", "", 200)
	var last struct {
		Next    int64             `json:"next"`
		HasMore bool              `json:"has_more"`
		Records []json.RawMessage `json:"records"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &last); err != nil || last.HasMore || last.Next != 102 || len(last.Records) != 2 {
		t.Fatalf("bad export completion: %+v %v", last, err)
	}
	response = f.request(t, http.MethodGet, "/api/vehicles/car-1/data/records?kind=events", "observer", "", 200)
	if !strings.Contains(response.Body.String(), `"records":[]`) {
		t.Fatal("export leaked another vehicle")
	}
	for _, query := range []string{"kind=events&after=-1", "kind=events&after=1", "kind=events&through=1&after=2",
		"kind=events&through=9007199254740992", "kind=events&after=0&after=0", "kind=events&unexpected=1",
		"kind=other", "kind=events&kind=tasks", "kind=events&broken=%zz", "kind=events;after=0"} {
		f.request(t, http.MethodGet, base+"/records?"+query, "observer", "", 400)
	}
	f.request(t, http.MethodGet, base+"/records?kind=events", "device2", "", 403)
	f.request(t, http.MethodGet, base+"/records?kind=events", "wrongtenant", "", 403)
	task := taskJSON("car-2", "export-query", "query")
	f.request(t, http.MethodPost, base+"/tasks", "controller", task, 202)
	report := `{"request_id":"export-query","report_sequence":1,"status":"received","reason":"persisted","mission_result":null}`
	f.request(t, http.MethodPost, base+"/task-results", "device2", report, 204)
	response = f.request(t, http.MethodGet, base+"/records?kind=tasks", "observer", "", 200)
	if !strings.Contains(response.Body.String(), `"status":"received"`) || !strings.Contains(response.Body.String(), `"request_id":"export-query"`) {
		t.Fatal("task export lost request or report")
	}
	var retained int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM data_events WHERE vehicle_id='car-2'").Scan(&retained); err != nil || retained != 103 {
		t.Fatal("export altered retained records")
	}
}
