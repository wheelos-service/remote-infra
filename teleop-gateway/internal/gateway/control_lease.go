package gateway

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const defaultControlLeaseTTL = 30 * time.Second

type ControlLeaseStore struct {
	client redis.UniversalClient
	ttl    time.Duration
}

func NewControlLeaseStore(redisURL string, ttl time.Duration) (*ControlLeaseStore, error) {
	options, err := redis.ParseURL(normalizeRedisURL(redisURL))
	if err != nil {
		return nil, fmt.Errorf("parse redis URL: %w", err)
	}
	if ttl <= 0 {
		ttl = defaultControlLeaseTTL
	}

	return &ControlLeaseStore{
		client: redis.NewClient(options),
		ttl:    ttl,
	}, nil
}

func (s *ControlLeaseStore) Ping(ctx context.Context) error {
	if err := s.client.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("ping control lease store: %w", err)
	}
	return nil
}

func (s *ControlLeaseStore) Acquire(ctx context.Context, vehicleID, operatorID string) (bool, error) {
	acquired, err := s.client.SetNX(ctx, controlLeaseKey(vehicleID), operatorID, s.ttl).Result()
	if err != nil {
		return false, fmt.Errorf("acquire control lease: %w", err)
	}
	return acquired, nil
}

func controlLeaseKey(vehicleID string) string {
	return "control:" + vehicleID
}

func normalizeRedisURL(redisURL string) string {
	if redisURL == "" {
		return "redis://localhost:6379/0"
	}
	if len(redisURL) >= len("redis://") && redisURL[:len("redis://")] == "redis://" {
		return redisURL
	}
	return "redis://" + redisURL + "/0"
}
