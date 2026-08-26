package gateway

import "testing"

func TestVehicleSelfMatchesRegisteredSubject(t *testing.T) {
	t.Setenv("VEHICLE_SUBJECT_MAP_JSON", `{"vehicle-client":"car-001"}`)
	identities, err := NewVehicleIdentityResolverFromEnvironment()
	if err != nil {
		t.Fatalf("NewVehicleIdentityResolverFromEnvironment() error = %v", err)
	}

	claims := &UserClaims{Name: "vehicle-client", Roles: []string{"vehicle"}}
	if !vehicleSelfMatches(claims, "car-001", identities) {
		t.Fatal("registered vehicle subject should match its resolved vehicle identity")
	}
}