package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	vehicleOnlineWindow = 10 * time.Second
	maxRetiredStreams   = 64
)

var errTelemetryConflict = errors.New("telemetry sequence or stream conflicts with stored state")

type VehicleTelemetryStore struct {
	client redis.UniversalClient
	now    func() time.Time
}

func NewVehicleTelemetryStore(client redis.UniversalClient, now func() time.Time) *VehicleTelemetryStore {
	if now == nil {
		now = time.Now
	}
	return &VehicleTelemetryStore{client: client, now: now}
}

// A single persistent hash keeps the snapshot and replay fences together.
// Never expire or evict retired IDs: expiration would allow stream resurrection.
var saveVehicleTelemetryScript = redis.NewScript(`
local stream = redis.call('HGET', KEYS[1], 'stream')
local now = tonumber(ARGV[3])
if stream then
  local received = tonumber(redis.call('HGET', KEYS[1], 'received_at_ms'))
  if not received or now < received then return 0 end
  if stream == ARGV[1] then
    local sequence = tonumber(redis.call('HGET', KEYS[1], 'sequence'))
    if not sequence or tonumber(ARGV[2]) <= sequence then return 0 end
  else
    if redis.call('HEXISTS', KEYS[1], 'retired:' .. ARGV[1]) == 1 then return 0 end
    if now - received <= tonumber(ARGV[5]) then return 0 end
    local count = tonumber(redis.call('HGET', KEYS[1], 'retired_count') or '0')
    if count >= tonumber(ARGV[6]) then return 0 end
    redis.call('HSET', KEYS[1], 'retired:' .. stream, '1', 'retired_count', count + 1)
  end
elseif redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], 'stream', ARGV[1], 'sequence', ARGV[2],
  'received_at_ms', ARGV[3], 'state', ARGV[4])
return 1
`)

func (s *VehicleTelemetryStore) Save(ctx context.Context, state validatedTelemetry) error {
	_, err := s.SaveAt(ctx, state)
	return err
}

func (s *VehicleTelemetryStore) SaveAt(ctx context.Context, state validatedTelemetry) (int64, error) {
	received := s.now().UnixMilli()
	saved, err := saveVehicleTelemetryScript.Run(ctx, s.client, []string{vehicleTelemetryKey(state.VehicleID)},
		state.StreamID, state.Sequence, received, []byte(state.Payload),
		vehicleOnlineWindow.Milliseconds(), maxRetiredStreams).Int()
	if err != nil {
		return 0, fmt.Errorf("save vehicle telemetry: %w", err)
	}
	if saved != 1 {
		return 0, errTelemetryConflict
	}
	return received, nil
}

func (s *VehicleTelemetryStore) Get(ctx context.Context, vehicleID string) (json.RawMessage, *int64, error) {
	fields, err := s.client.HGetAll(ctx, vehicleTelemetryKey(vehicleID)).Result()
	if err != nil {
		return nil, nil, fmt.Errorf("get vehicle telemetry: %w", err)
	}
	if len(fields) == 0 {
		return nil, nil, nil
	}
	received, err := strconv.ParseInt(fields["received_at_ms"], 10, 64)
	if err != nil || received <= 0 {
		return nil, nil, errors.New("invalid stored receipt timestamp")
	}
	state, err := validateVehicleTelemetry([]byte(fields["state"]))
	if err != nil || state.VehicleID != vehicleID {
		return nil, nil, errors.New("invalid stored vehicle telemetry")
	}
	return state.Payload, &received, nil
}

func vehicleTelemetryKey(vehicleID string) string {
	return "vehicle-telemetry:" + vehicleID
}
