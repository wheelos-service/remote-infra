package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

type VehicleIdentityResolver struct {
	bySubject map[string]string
}

func NewVehicleIdentityResolverFromEnvironment() (*VehicleIdentityResolver, error) {
	resolver := &VehicleIdentityResolver{bySubject: map[string]string{}}
	raw := os.Getenv("VEHICLE_SUBJECT_MAP_JSON")
	if raw == "" {
		return resolver, nil
	}
	if err := json.Unmarshal([]byte(raw), &resolver.bySubject); err != nil {
		return nil, fmt.Errorf("parse VEHICLE_SUBJECT_MAP_JSON: %w", err)
	}
	for subject, vehicleID := range resolver.bySubject {
		if subject == "" || vehicleID == "" {
			return nil, errors.New("vehicle subject map cannot contain empty subject or vehicle id")
		}
	}
	return resolver, nil
}

func (r *VehicleIdentityResolver) Resolve(subject string) (string, bool) {
	vehicleID, ok := r.bySubject[subject]
	return vehicleID, ok
}

func (r *VehicleIdentityResolver) Strict() bool {
	return len(r.bySubject) > 0
}
