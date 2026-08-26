package gateway

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

type VehiclePermission string

const (
	ObservePermission VehiclePermission = "observe"
	ControlPermission VehiclePermission = "control"
)

type VehicleACL struct {
	UserID      string              `json:"user_id"`
	TenantID    string              `json:"tenant_id,omitempty"`
	VehicleID   string              `json:"vehicle_id"`
	Permissions []VehiclePermission `json:"permissions"`
}

type VehicleAuthorizer struct {
	entries []VehicleACL
}

func NewVehicleAuthorizer(entries []VehicleACL) (*VehicleAuthorizer, error) {
	for _, entry := range entries {
		if entry.UserID == "" || entry.VehicleID == "" || len(entry.Permissions) == 0 {
			return nil, errors.New("each vehicle ACL entry requires user_id, vehicle_id, and permissions")
		}
		for _, permission := range entry.Permissions {
			if permission != ObservePermission && permission != ControlPermission {
				return nil, fmt.Errorf("unsupported vehicle ACL permission %q", permission)
			}
		}
	}
	return &VehicleAuthorizer{entries: entries}, nil
}

func NewVehicleAuthorizerFromEnvironment() (*VehicleAuthorizer, error) {
	rawEntries := os.Getenv("VEHICLE_ACL_JSON")
	if rawEntries == "" {
		return NewVehicleAuthorizer(nil)
	}
	var entries []VehicleACL
	if err := json.Unmarshal([]byte(rawEntries), &entries); err != nil {
		return nil, fmt.Errorf("parse VEHICLE_ACL_JSON: %w", err)
	}
	return NewVehicleAuthorizer(entries)
}

func (a *VehicleAuthorizer) Authorize(claims *UserClaims, vehicleID string, permission VehiclePermission) bool {
	if claims == nil || vehicleID == "" {
		return false
	}
	for _, entry := range a.entries {
		if entry.UserID != claims.Name || entry.VehicleID != vehicleID {
			continue
		}
		if entry.TenantID != "" && entry.TenantID != claims.Organization {
			continue
		}
		for _, granted := range entry.Permissions {
			if granted == permission || (granted == ControlPermission && permission == ObservePermission) {
				return true
			}
		}
	}
	return false
}