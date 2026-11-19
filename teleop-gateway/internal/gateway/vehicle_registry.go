package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
)

type RegisteredVehicle struct {
	VehicleID string `json:"vehicle_id"`
	Name      string `json:"name"`
}

type VehicleRegistry struct {
	vehicles []RegisteredVehicle
	byID     map[string]RegisteredVehicle
}

func NewVehicleRegistryFromEnvironment() (*VehicleRegistry, error) {
	raw := os.Getenv("VEHICLE_REGISTRY_JSON")
	if raw == "" {
		raw = "[]"
	}
	if err := rejectDuplicateJSONFields([]byte(raw)); err != nil {
		return nil, fmt.Errorf("parse VEHICLE_REGISTRY_JSON: %w", err)
	}
	var vehicles []RegisteredVehicle
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&vehicles); err != nil {
		return nil, fmt.Errorf("parse VEHICLE_REGISTRY_JSON: %w", err)
	}
	if err := requireJSONEnd(decoder); err != nil {
		return nil, err
	}
	if vehicles == nil {
		return nil, errors.New("VEHICLE_REGISTRY_JSON must be an array, not null")
	}
	registry := &VehicleRegistry{vehicles: vehicles, byID: make(map[string]RegisteredVehicle, len(vehicles))}
	for _, vehicle := range vehicles {
		if !telemetryIdentifier.MatchString(vehicle.VehicleID) || strings.TrimSpace(vehicle.Name) == "" {
			return nil, errors.New("each registered vehicle requires a valid vehicle_id and nonempty name")
		}
		if _, exists := registry.byID[vehicle.VehicleID]; exists {
			return nil, fmt.Errorf("duplicate registered vehicle_id %q", vehicle.VehicleID)
		}
		registry.byID[vehicle.VehicleID] = vehicle
	}
	return registry, nil
}
