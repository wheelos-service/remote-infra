package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

const maxAuthorizationPolicyBytes = 1 << 20

type authorizationPolicy struct {
	Vehicles  []authorizationPolicyVehicle `json:"vehicles"`
	Operators []VehicleACL                 `json:"operators"`
}

type authorizationPolicyVehicle struct {
	VehicleID string `json:"vehicle_id"`
	Name      string `json:"name"`
	Subject   string `json:"subject"`
}

func ParseAuthorizationPolicy(raw []byte) (*VehicleRegistry, *VehicleIdentityResolver, *VehicleAuthorizer, error) {
	if len(raw) == 0 || len(raw) > maxAuthorizationPolicyBytes {
		return nil, nil, nil, errors.New("authorization policy must be between 1 byte and 1 MiB")
	}
	if err := rejectDuplicateJSONFields(raw); err != nil {
		return nil, nil, nil, fmt.Errorf("parse authorization policy: %w", err)
	}

	var policy authorizationPolicy
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return nil, nil, nil, fmt.Errorf("parse authorization policy: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return nil, nil, nil, err
	}
	if policy.Vehicles == nil || policy.Operators == nil {
		return nil, nil, nil, errors.New("authorization policy requires vehicles and operators arrays")
	}

	registry := &VehicleRegistry{
		vehicles: make([]RegisteredVehicle, 0, len(policy.Vehicles)),
		byID:     make(map[string]RegisteredVehicle, len(policy.Vehicles)),
	}
	identities := &VehicleIdentityResolver{bySubject: make(map[string]string, len(policy.Vehicles)), strict: true}
	for _, entry := range policy.Vehicles {
		if !telemetryIdentifier.MatchString(entry.VehicleID) ||
			strings.TrimSpace(entry.Name) == "" || strings.TrimSpace(entry.Subject) == "" {
			return nil, nil, nil, errors.New("each policy vehicle requires a valid vehicle_id, name, and subject")
		}
		if _, exists := registry.byID[entry.VehicleID]; exists {
			return nil, nil, nil, fmt.Errorf("duplicate policy vehicle_id %q", entry.VehicleID)
		}
		if _, exists := identities.bySubject[entry.Subject]; exists {
			return nil, nil, nil, fmt.Errorf("duplicate vehicle subject %q", entry.Subject)
		}
		vehicle := RegisteredVehicle{VehicleID: entry.VehicleID, Name: entry.Name}
		registry.vehicles = append(registry.vehicles, vehicle)
		registry.byID[entry.VehicleID] = vehicle
		identities.bySubject[entry.Subject] = entry.VehicleID
	}

	for _, entry := range policy.Operators {
		if _, exists := registry.byID[entry.VehicleID]; !exists {
			return nil, nil, nil, fmt.Errorf("operator ACL references unregistered vehicle %q", entry.VehicleID)
		}
	}
	authorizer, err := NewVehicleAuthorizer(policy.Operators)
	if err != nil {
		return nil, nil, nil, err
	}
	return registry, identities, authorizer, nil
}

func NewAuthorizationPolicyFromEnvironment() (*VehicleRegistry, *VehicleIdentityResolver, *VehicleAuthorizer, error) {
	managed, err := managedAuthorizationConfigured()
	if err != nil {
		return nil, nil, nil, err
	}
	if managed {
		return &VehicleRegistry{byID: map[string]RegisteredVehicle{}},
			&VehicleIdentityResolver{bySubject: map[string]string{}, strict: true},
			&VehicleAuthorizer{}, nil
	}
	path := strings.TrimSpace(os.Getenv("AUTHORIZATION_POLICY_FILE"))
	if path != "" {
		for _, name := range []string{"VEHICLE_REGISTRY_JSON", "VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON"} {
			if strings.TrimSpace(os.Getenv(name)) != "" {
				return nil, nil, nil, fmt.Errorf("%s and legacy %s must not be configured together", "AUTHORIZATION_POLICY_FILE", name)
			}
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read authorization policy metadata: %w", err)
		}
		if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxAuthorizationPolicyBytes {
			return nil, nil, nil, errors.New("authorization policy must be a regular file no larger than 1 MiB")
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read authorization policy: %w", err)
		}
		return ParseAuthorizationPolicy(raw)
	}

	registry, err := NewVehicleRegistryFromEnvironment()
	if err != nil {
		return nil, nil, nil, err
	}
	identities, err := NewVehicleIdentityResolverFromEnvironment()
	if err != nil {
		return nil, nil, nil, err
	}
	authorizer, err := NewVehicleAuthorizerFromEnvironment()
	if err != nil {
		return nil, nil, nil, err
	}
	return registry, identities, authorizer, nil
}
