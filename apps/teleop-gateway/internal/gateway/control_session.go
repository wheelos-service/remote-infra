package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

type ControlSessionStatus string

const (
	ControlSessionActive   ControlSessionStatus = "ACTIVE"
	ControlSessionReleased ControlSessionStatus = "RELEASED"
	ControlSessionExpired  ControlSessionStatus = "EXPIRED"
	ControlSessionRevoked  ControlSessionStatus = "REVOKED"
)

var (
	ErrControlLeaseHeld       = errors.New("control lease is already held")
	ErrControlSessionNotFound = errors.New("control session not found")
	ErrControlSessionOwner    = errors.New("control session is not owned by operator")
)

type ControlSession struct {
	SessionID    string               `json:"session_id"`
	VehicleID    string               `json:"vehicle_id"`
	OperatorID   string               `json:"operator_id"`
	PublicKeyB64 string               `json:"public_key_b64"`
	Status       ControlSessionStatus `json:"status"`
	CreatedAtMS  int64                `json:"created_at_ms"`
	ExpiresAtMS  int64                `json:"expires_at_ms"`
}

var acquireControlSessionScript = redis.NewScript(`
if redis.call('EXISTS', KEYS[1]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[2])
return 1
`)

var renewControlSessionScript = redis.NewScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
if redis.call('GET', KEYS[2]) ~= ARGV[5] then
	return 0
end
local session = cjson.decode(raw)
if session.session_id ~= ARGV[1] or session.operator_id ~= ARGV[2] or session.status ~= 'ACTIVE' then
  return -1
end
session.expires_at_ms = tonumber(ARGV[3])
redis.call('SET', KEYS[1], cjson.encode(session), 'XX', 'PX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[5], 'XX', 'PX', ARGV[4])
return 1
`)

var releaseControlSessionScript = redis.NewScript(`
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local session = cjson.decode(raw)
if session.session_id ~= ARGV[1] or session.operator_id ~= ARGV[2] then
  return -1
end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`)

func (s *ControlLeaseStore) AcquireControlSession(ctx context.Context, session ControlSession) error {
	payload, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("marshal control session: %w", err)
	}

	result, err := acquireControlSessionScript.Run(
		ctx,
		s.client,
		[]string{controlLeaseKey(session.VehicleID), controlSessionIndexKey(session.SessionID)},
		payload,
		s.ttl.Milliseconds(),
		session.VehicleID,
	).Int()
	if err != nil {
		return fmt.Errorf("acquire control session: %w", err)
	}
	if result == 0 {
		return ErrControlLeaseHeld
	}
	return nil
}

func (s *ControlLeaseStore) GetControlSession(ctx context.Context, vehicleID string) (ControlSession, error) {
	raw, err := s.client.Get(ctx, controlLeaseKey(vehicleID)).Bytes()
	if errors.Is(err, redis.Nil) {
		return ControlSession{}, ErrControlSessionNotFound
	}
	if err != nil {
		return ControlSession{}, fmt.Errorf("get control session: %w", err)
	}

	var session ControlSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return ControlSession{}, fmt.Errorf("decode control session: %w", err)
	}
	return session, nil
}

func (s *ControlLeaseStore) RenewControlSession(ctx context.Context, sessionID, operatorID string) (ControlSession, error) {
	session, err := s.getSessionByID(ctx, sessionID)
	if err != nil {
		return ControlSession{}, err
	}
	if session.OperatorID != operatorID {
		return ControlSession{}, ErrControlSessionOwner
	}

	expiresAt := time.Now().Add(s.ttl).UnixMilli()
	result, err := renewControlSessionScript.Run(
		ctx,
		s.client,
		[]string{controlLeaseKey(session.VehicleID), controlSessionIndexKey(sessionID)},
		sessionID,
		operatorID,
		expiresAt,
		s.ttl.Milliseconds(),
		session.VehicleID,
	).Int()
	if err != nil {
		return ControlSession{}, fmt.Errorf("renew control session: %w", err)
	}
	if result == 0 {
		return ControlSession{}, ErrControlSessionNotFound
	}
	if result < 0 {
		return ControlSession{}, ErrControlSessionOwner
	}

	session.ExpiresAtMS = expiresAt
	return session, nil
}

func (s *ControlLeaseStore) ReleaseControlSession(ctx context.Context, sessionID, operatorID string) error {
	session, err := s.getSessionByID(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.OperatorID != operatorID {
		return ErrControlSessionOwner
	}

	result, err := releaseControlSessionScript.Run(
		ctx,
		s.client,
		[]string{controlLeaseKey(session.VehicleID), controlSessionIndexKey(sessionID)},
		sessionID,
		operatorID,
	).Int()
	if err != nil {
		return fmt.Errorf("release control session: %w", err)
	}
	if result == 0 {
		return ErrControlSessionNotFound
	}
	if result < 0 {
		return ErrControlSessionOwner
	}
	return nil
}

func (s *ControlLeaseStore) getSessionByID(ctx context.Context, sessionID string) (ControlSession, error) {
	vehicleID, err := s.client.Get(ctx, controlSessionIndexKey(sessionID)).Result()
	if errors.Is(err, redis.Nil) {
		return ControlSession{}, ErrControlSessionNotFound
	}
	if err != nil {
		return ControlSession{}, fmt.Errorf("get control session index: %w", err)
	}

	session, err := s.GetControlSession(ctx, vehicleID)
	if errors.Is(err, ErrControlSessionNotFound) {
		return ControlSession{}, ErrControlSessionNotFound
	}
	if err != nil {
		return ControlSession{}, err
	}
	if session.SessionID != sessionID {
		return ControlSession{}, ErrControlSessionNotFound
	}
	return session, nil
}

func controlSessionIndexKey(sessionID string) string {
	return "control-session:" + sessionID
}
