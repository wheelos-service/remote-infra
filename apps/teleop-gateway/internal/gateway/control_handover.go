package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

type ControlHandover struct {
	VehicleID                string `json:"vehicle_id"`
	SessionID                string `json:"session_id"`
	Revision                 int64  `json:"revision"`
	State                    string `json:"state"`
	EdgeRevocationApplied    bool   `json:"edge_revocation_applied"`
	VehicleHandoverConfirmed bool   `json:"vehicle_handover_confirmed"`
}

func controlHandoverKey(vehicleID string) string { return "control-handover:" + vehicleID }

func operatorControlKey(tenant, operator string) string {
	raw, _ := json.Marshal([]string{tenant, operator})
	return fmt.Sprintf("operator-control:%x", sha256.Sum256(raw))
}

var getHandoverScript = redis.NewScript(`
local revision = redis.call('HGET', KEYS[1], 'revision')
if not revision then
  if redis.call('EXISTS', KEYS[1]) == 1 then
    return redis.error_reply('incomplete handover fence')
  end
  return {}
end
local session = redis.call('HGET', KEYS[1], 'session')
local state = redis.call('HGET', KEYS[1], 'state')
if session and state == 'ACTIVE' then
  local raw = redis.call('GET', KEYS[2])
  if not raw or redis.call('PTTL', KEYS[2]) <= 0 then
    state = 'PENDING'
    redis.call('HSET', KEYS[1], 'state', state)
  elseif cjson.decode(raw).session_id ~= cjson.decode(session).session_id then
    return redis.error_reply('handover lease mismatch')
  end
end
return {revision, session or '', state or '', redis.call('HGET', KEYS[1], 'confirmed_session') or '',
  redis.call('HGET', KEYS[1], 'edge_revocation_applied') or '0'}
`)

func (s *ControlLeaseStore) GetHandover(ctx context.Context, vehicleID string) (ControlHandover, error) {
	result, err := getHandoverScript.Run(ctx, s.client,
		[]string{controlHandoverKey(vehicleID), controlLeaseKey(vehicleID)}).StringSlice()
	response := ControlHandover{VehicleID: vehicleID, State: "NONE"}
	if err != nil {
		return response, fmt.Errorf("read handover: %w", err)
	}
	if len(result) == 0 {
		return response, nil
	}
	if len(result) != 5 {
		return response, errors.New("invalid handover state")
	}
	response.Revision, err = strconv.ParseInt(result[0], 10, 64)
	if err != nil || response.Revision < 1 {
		return response, errors.New("invalid handover revision")
	}
	response.State = result[2]
	response.EdgeRevocationApplied = result[4] == "1"
	switch response.State {
	case "ACTIVE", "PENDING":
		var session ControlSession
		if json.Unmarshal([]byte(result[1]), &session) != nil || session.VehicleID != vehicleID || session.SessionID == "" {
			return response, errors.New("invalid handover session")
		}
		response.SessionID = session.SessionID
	case "CONFIRMED":
		if result[3] == "" || !response.EdgeRevocationApplied {
			return response, errors.New("missing confirmed handover session")
		}
		response.SessionID = result[3]
		response.VehicleHandoverConfirmed = true
	default:
		return response, errors.New("invalid handover lifecycle")
	}
	return response, nil
}

var acknowledgeHandoverScript = redis.NewScript(`
local revision = redis.call('HGET', KEYS[1], 'revision')
if revision ~= ARGV[1] then return 0 end
local raw = redis.call('HGET', KEYS[1], 'session')
if not raw then
  if redis.call('HGET', KEYS[1], 'confirmed_session') == ARGV[2] then return 1 end
  return 0
end
local session = cjson.decode(raw)
if session.session_id ~= ARGV[2] then return 0 end
-- Explicit release or lease expiry must precede physical acknowledgement.
local active = redis.call('GET', KEYS[2])
if active and redis.call('PTTL', KEYS[2]) > 0 then return -1 end
local operatorKey = redis.call('HGET', KEYS[1], 'operator_key')
if not operatorKey or redis.call('GET', operatorKey) ~= ARGV[2] then
  return redis.error_reply('operator handover fence mismatch')
end
redis.call('HSET', KEYS[1], 'edge_revocation_applied', '1')
if ARGV[3] ~= '1' then
  redis.call('HSET', KEYS[1], 'state', 'PENDING')
  return 1
end
redis.call('DEL', operatorKey)
redis.call('HDEL', KEYS[1], 'session', 'operator_key')
redis.call('HSET', KEYS[1], 'state', 'CONFIRMED', 'confirmed_session', ARGV[2])
return 1
`)

func (s *ControlLeaseStore) AcknowledgeHandover(ctx context.Context, vehicleID, sessionID string, revision int64) error {
	return s.ReportHandover(ctx, vehicleID, sessionID, revision, true)
}

func (s *ControlLeaseStore) ReportHandover(ctx context.Context, vehicleID, sessionID string, revision int64, vehicleConfirmed bool) error {
	confirmed := "0"
	if vehicleConfirmed {
		confirmed = "1"
	}
	result, err := acknowledgeHandoverScript.Run(ctx, s.client,
		[]string{controlHandoverKey(vehicleID), controlLeaseKey(vehicleID)},
		revision, sessionID, confirmed).Int()
	if err != nil {
		return fmt.Errorf("acknowledge handover: %w", err)
	}
	if result != 1 {
		return ErrControlHandoverPending
	}
	return nil
}
