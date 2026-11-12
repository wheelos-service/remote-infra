package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type VideoMode string

const (
	VideoStandby VideoMode = "STANDBY"
	VideoActive  VideoMode = "ACTIVE"
)

type VideoSession struct {
	VehicleID           string    `json:"vehicle_id"`
	SessionID           string    `json:"session_id"`
	Mode                VideoMode `json:"mode"`
	ViewerCount         int       `json:"viewer_count"`
	ControllerSessionID string    `json:"controller_session_id,omitempty"`
	GraceDeadlineMS     int64     `json:"grace_deadline_ms,omitempty"`
	CreatedAtMS         int64     `json:"created_at_ms"`
	ExpiresAtMS         int64     `json:"expires_at_ms"`
}

var ErrVideoSessionNotFound = errors.New("video session not found")

type VideoSessionStore struct {
	client      redis.UniversalClient
	gracePeriod time.Duration
}

func NewVideoSessionStore(client redis.UniversalClient, gracePeriod time.Duration) *VideoSessionStore {
	return &VideoSessionStore{client: client, gracePeriod: gracePeriod}
}

func videoSessionKey(vehicleID string) string { return "video_session:" + vehicleID }
func videoViewerKey(sessionID string) string  { return "video_viewer:" + sessionID }

func (s *VideoSessionStore) Get(ctx context.Context, vehicleID string) (VideoSession, error) {
	raw, err := s.client.Get(ctx, videoSessionKey(vehicleID)).Bytes()
	if errors.Is(err, redis.Nil) {
		now := time.Now().UnixMilli()
		return VideoSession{VehicleID: vehicleID, Mode: VideoStandby, CreatedAtMS: now, ExpiresAtMS: now}, nil
	}
	if err != nil {
		return VideoSession{}, fmt.Errorf("get video session: %w", err)
	}
	var session VideoSession
	if err := json.Unmarshal(raw, &session); err != nil {
		return VideoSession{}, fmt.Errorf("decode video session: %w", err)
	}
	if session.Mode == VideoActive && session.ViewerCount == 0 && session.ControllerSessionID == "" && session.GraceDeadlineMS > 0 && time.Now().UnixMilli() >= session.GraceDeadlineMS {
		session.Mode = VideoStandby
		session.GraceDeadlineMS = 0
		if err := s.save(ctx, session); err != nil {
			return VideoSession{}, err
		}
	}
	return session, nil
}

func (s *VideoSessionStore) AcquireViewer(ctx context.Context, vehicleID string) (VideoSession, error) {
	session, err := s.Get(ctx, vehicleID)
	if err != nil {
		return VideoSession{}, err
	}
	if session.SessionID == "" {
		session.SessionID = uuid.NewString()
		session.CreatedAtMS = time.Now().UnixMilli()
	}
	session.ViewerCount++
	session.Mode = VideoActive
	session.GraceDeadlineMS = 0
	if err := s.save(ctx, session); err != nil {
		return VideoSession{}, err
	}
	if err := s.client.Set(ctx, videoViewerKey(session.SessionID), vehicleID, s.gracePeriod+time.Hour).Err(); err != nil {
		return VideoSession{}, fmt.Errorf("index video viewer: %w", err)
	}
	return session, nil
}

func (s *VideoSessionStore) ReleaseViewer(ctx context.Context, sessionID string) (VideoSession, error) {
	vehicleID, err := s.client.Get(ctx, videoViewerKey(sessionID)).Result()
	if errors.Is(err, redis.Nil) {
		return VideoSession{}, ErrVideoSessionNotFound
	}
	if err != nil {
		return VideoSession{}, fmt.Errorf("find video viewer: %w", err)
	}
	session, err := s.Get(ctx, vehicleID)
	if err != nil {
		return VideoSession{}, err
	}
	if session.ViewerCount > 0 {
		session.ViewerCount--
	}
	_ = s.client.Del(ctx, videoViewerKey(sessionID)).Err()
	return s.saveAfterViewerChange(ctx, session)
}

func (s *VideoSessionStore) SetController(ctx context.Context, vehicleID, controlSessionID string) (VideoSession, error) {
	session, err := s.Get(ctx, vehicleID)
	if err != nil {
		return VideoSession{}, err
	}
	if session.SessionID == "" {
		session.SessionID = uuid.NewString()
		session.CreatedAtMS = time.Now().UnixMilli()
	}
	session.ControllerSessionID = controlSessionID
	session.Mode = VideoActive
	session.GraceDeadlineMS = 0
	return session, s.save(ctx, session)
}

func (s *VideoSessionStore) ClearController(ctx context.Context, vehicleID, controlSessionID string) (VideoSession, error) {
	session, err := s.Get(ctx, vehicleID)
	if err != nil {
		return VideoSession{}, err
	}
	if session.ControllerSessionID == controlSessionID {
		session.ControllerSessionID = ""
	}
	return s.saveAfterViewerChange(ctx, session)
}

func (s *VideoSessionStore) saveAfterViewerChange(ctx context.Context, session VideoSession) (VideoSession, error) {
	if session.ViewerCount == 0 && session.ControllerSessionID == "" {
		session.Mode = VideoActive
		session.GraceDeadlineMS = time.Now().Add(s.gracePeriod).UnixMilli()
	}
	return session, s.save(ctx, session)
}

func (s *VideoSessionStore) save(ctx context.Context, session VideoSession) error {
	if session.ExpiresAtMS == 0 {
		session.ExpiresAtMS = time.Now().Add(24 * time.Hour).UnixMilli()
	}
	payload, err := json.Marshal(session)
	if err != nil {
		return fmt.Errorf("marshal video session: %w", err)
	}
	if err := s.client.Set(ctx, videoSessionKey(session.VehicleID), payload, 24*time.Hour).Err(); err != nil {
		return fmt.Errorf("save video session: %w", err)
	}
	return nil
}
