package gateway

import (
	"os"
	"testing"
)

func TestVehicleIdentityResolverRequiresRegisteredSubject(t *testing.T) {
	t.Setenv("VEHICLE_SUBJECT_MAP_JSON", `{"vehicle-subject-001":"vehicle-001"}`)
	resolver, err := NewVehicleIdentityResolverFromEnvironment()
	if err != nil {
		t.Fatalf("NewVehicleIdentityResolverFromEnvironment() error = %v", err)
	}

	vehicleID, ok := resolver.Resolve("vehicle-subject-001")
	if !ok || vehicleID != "vehicle-001" {
		t.Fatalf("Resolve() = %q, %v; want vehicle-001, true", vehicleID, ok)
	}
	if _, ok := resolver.Resolve("unknown-subject"); ok {
		t.Fatal("Resolve() unknown subject = true, want false")
	}
}

func TestVehicleIdentityResolverRejectsInvalidMap(t *testing.T) {
	t.Setenv("VEHICLE_SUBJECT_MAP_JSON", `{"":"vehicle-001"}`)
	if _, err := NewVehicleIdentityResolverFromEnvironment(); err == nil {
		t.Fatal("NewVehicleIdentityResolverFromEnvironment() error = nil, want error")
	}

	_ = os.Unsetenv("VEHICLE_SUBJECT_MAP_JSON")
}

func TestVehicleScopeAllowsMappedSubjectWithoutRole(t *testing.T) {
	t.Setenv("VEHICLE_SUBJECT_MAP_JSON", `{"vehicle-subject-001":"vehicle-001"}`)
	resolver, err := NewVehicleIdentityResolverFromEnvironment()
	if err != nil {
		t.Fatalf("NewVehicleIdentityResolver() error = %v", err)
	}

	vehicleID, mapped := resolver.Resolve("vehicle-subject-001")
	if !mapped || vehicleID != "vehicle-001" {
		t.Fatalf("Resolve() = %q, %v; want vehicle-001, true", vehicleID, mapped)
	}
	if !hasScope([]string{"teleop:vehicle"}, "teleop:vehicle") {
		t.Fatal("vehicle scope was not recognized")
	}
}