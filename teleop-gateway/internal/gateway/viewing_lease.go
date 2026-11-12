package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const viewingLeaseTTL = 30 * time.Second

var (
	errViewingGone  = errors.New("viewing lease expired or released")
	errViewingOwner = errors.New("viewing lease owner mismatch")
	errViewingLimit = errors.New("vehicle viewing lease limit reached")
)

type ViewingLease struct {
	VehicleID        string `json:"vehicle_id"`
	ViewingSessionID string `json:"viewing_session_id"`
	ExpiresAtMS      int64  `json:"expires_at_ms"`
	ServerTimeMS     int64  `json:"server_time_ms"`
	RenewAfterMS     int64  `json:"renew_after_ms"`
}

type MediaDemand struct {
	VehicleID       string `json:"vehicle_id"`
	Epoch           string `json:"epoch"`
	Revision        int64  `json:"revision"`
	RTCRequired     bool   `json:"rtc_required"`
	VideoRequired   bool   `json:"video_required"`
	ViewerCount     int64  `json:"viewer_count"`
	ControlRequired bool   `json:"control_required"`
	ServerTimeMS    int64  `json:"server_time_ms"`
	ValidUntilMS    int64  `json:"valid_until_ms"`
	RetryAfterMS    int64  `json:"retry_after_ms"`
}

type ViewingLeaseStore struct {
	client redis.UniversalClient
}

// Redis TIME, rather than a Gateway instance's wall clock, owns all deadlines.
// The lease tombstone survives one day so a delayed acquire cannot revive it.
var viewingLeaseScript = redis.NewScript(`
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local op = ARGV[1]
local owner = ARGV[2]
local sid = ARGV[3]
local ttl = tonumber(ARGV[4])
local state = redis.call('HMGET', KEYS[3], 'epoch', 'revision', 'signature', 'server_time_ms')
if (state[1] or state[2] or state[3] or state[4])
  and not (state[1] and state[2] and state[3] and state[4]) then
  return redis.error_reply('incomplete media demand metadata')
end
local epoch = state[1] or ARGV[5]
local revision = tonumber(state[2] or '0')
if not revision or revision < 0 or revision ~= math.floor(revision)
  or revision >= 9007199254740991 or (state[1] and revision == 0) then
  return redis.error_reply('invalid demand revision')
end
if state[4] and (not tonumber(state[4]) or now < tonumber(state[4])) then
  return redis.error_reply('media demand clock moved backwards')
end
local dirty = false
-- Validate the collection type before mutations: Lua errors do not roll back.
redis.call('ZCOUNT', KEYS[1], '-inf', '+inf')

-- Decode and validate the control authority before any writes. A stale
-- video-session controller reference is deliberately never consulted.
local controlRaw = redis.call('GET', KEYS[4])
local controlUntil = 0
local controlID = ''
if controlRaw then
  local control = cjson.decode(controlRaw)
  local remaining = redis.call('PTTL', KEYS[4])
  if type(control) ~= 'table' or type(control.session_id) ~= 'string'
    or type(control.expires_at_ms) ~= 'number' or control.status ~= 'ACTIVE'
    or remaining <= 0 then
    return redis.error_reply('invalid control lease')
  end
  controlUntil = math.min(control.expires_at_ms, now + remaining)
  if controlUntil > now then controlID = control.session_id end
end

local raw = redis.call('GET', KEYS[2])
local lease = nil
if raw then
  lease = cjson.decode(raw)
  if type(lease) ~= 'table' or type(lease.owner) ~= 'string'
    or type(lease.expires_at_ms) ~= 'number' or type(lease.released) ~= 'boolean' then
    return redis.error_reply('invalid viewing lease')
  end
  if op ~= 'demand' and lease.owner ~= owner then return {'owner'} end
end
if op == 'acquire' then
  if lease then
    if lease.released or lease.expires_at_ms <= now then return {'gone'} end
  else
    local count = redis.call('ZCOUNT', KEYS[1], '(' .. now, '+inf')
    if count >= 64 then return {'limit'} end
    lease = {owner=owner, expires_at_ms=now + ttl, released=false}
    dirty = true
  end
elseif op == 'renew' then
  if not lease or lease.released or lease.expires_at_ms <= now then return {'gone'} end
  lease.expires_at_ms = now + ttl
  dirty = true
elseif op == 'release' then
  if not lease then return {'gone'} end
  if not lease.released then
    lease.released = true
    dirty = true
  end
end

if op == 'acquire' or op == 'renew' or op == 'release' then
  if dirty then redis.call('SET', KEYS[2], cjson.encode(lease), 'PX', 86400000) end
  if lease.released then
    redis.call('ZREM', KEYS[1], sid)
  else
    redis.call('ZADD', KEYS[1], lease.expires_at_ms, sid)
  end
end
local removed = redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if removed > 0 then dirty = true end
local count = redis.call('ZCARD', KEYS[1])
local latest = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
local viewerUntil = 0
if #latest > 0 then viewerUntil = tonumber(latest[2]) end
local required = count > 0 or controlUntil > now
local signature = tostring(count) .. ':' .. controlID .. ':' .. tostring(required)
if signature ~= state[3] then dirty = true end
if dirty then revision = revision + 1 end
redis.call('HSET', KEYS[3], 'epoch', epoch, 'revision', revision,
  'signature', signature, 'server_time_ms', now)
local validUntil = now + 5000
if required then validUntil = math.min(validUntil, math.max(viewerUntil, controlUntil)) end
if op == 'demand' then
  return {'ok', epoch, tostring(revision), tostring(count), controlID ~= '' and '1' or '0',
    tostring(now), tostring(validUntil)}
end
return {'ok', tostring(lease.expires_at_ms), tostring(now)}
`)

func viewingOwner(claims *UserClaims) string {
	raw, _ := json.Marshal([]string{claims.Organization, claims.Name})
	return fmt.Sprintf("%x", sha256.Sum256(raw))
}

func viewingSessionID(vehicleID, owner, instanceID, requestID string) string {
	raw, _ := json.Marshal([]string{vehicleID, owner, instanceID, requestID})
	return uuid.NewSHA1(uuid.NameSpaceOID, raw).String()
}

func (s *ViewingLeaseStore) run(ctx context.Context, op, vehicleID, owner, sessionID string) ([]string, error) {
	prefix := "viewing:" + vehicleID
	result, err := viewingLeaseScript.Run(ctx, s.client, []string{
		prefix + ":active", prefix + ":lease:" + sessionID,
		prefix + ":demand", controlLeaseKey(vehicleID),
	}, op, owner, sessionID, viewingLeaseTTL.Milliseconds(), uuid.NewString()).StringSlice()
	if err != nil {
		return nil, fmt.Errorf("coordinate viewing lease: %w", err)
	}
	if len(result) == 0 {
		return nil, errors.New("empty viewing lease result")
	}
	switch result[0] {
	case "gone":
		return nil, errViewingGone
	case "owner":
		return nil, errViewingOwner
	case "limit":
		return nil, errViewingLimit
	case "ok":
		return result, nil
	default:
		return nil, errors.New("invalid viewing lease result")
	}
}

func (s *ViewingLeaseStore) mutate(ctx context.Context, op, vehicleID, owner, sessionID string) (ViewingLease, error) {
	result, err := s.run(ctx, op, vehicleID, owner, sessionID)
	if err != nil {
		return ViewingLease{}, err
	}
	if len(result) != 3 {
		return ViewingLease{}, errors.New("invalid viewing deadline result")
	}
	expires, err := strconv.ParseInt(result[1], 10, 64)
	if err != nil {
		return ViewingLease{}, err
	}
	now, err := strconv.ParseInt(result[2], 10, 64)
	if err != nil {
		return ViewingLease{}, err
	}
	return ViewingLease{
		VehicleID: vehicleID, ViewingSessionID: sessionID, ExpiresAtMS: expires,
		ServerTimeMS: now, RenewAfterMS: viewingLeaseTTL.Milliseconds() / 3,
	}, nil
}

func (s *ViewingLeaseStore) Demand(ctx context.Context, vehicleID string) (MediaDemand, error) {
	result, err := s.run(ctx, "demand", vehicleID, "", "")
	if err != nil {
		return MediaDemand{}, err
	}
	demand := MediaDemand{VehicleID: vehicleID, RetryAfterMS: 1000}
	if len(result) != 7 {
		return demand, errors.New("invalid media demand result")
	}
	demand.Epoch = result[1]
	for i, value := range []*int64{&demand.Revision, &demand.ViewerCount, &demand.ServerTimeMS, &demand.ValidUntilMS} {
		index := []int{2, 3, 5, 6}[i]
		parsed, err := strconv.ParseInt(result[index], 10, 64)
		if err != nil {
			return MediaDemand{}, err
		}
		*value = parsed
	}
	demand.ControlRequired = result[4] == "1"
	demand.RTCRequired = demand.ViewerCount > 0 || demand.ControlRequired
	demand.VideoRequired = demand.RTCRequired
	return demand, nil
}
