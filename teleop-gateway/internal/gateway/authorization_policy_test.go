package gateway

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseAuthorizationPolicy(t *testing.T) {
	registry, identities, authorizer, err := ParseAuthorizationPolicy([]byte(`{
		"vehicles":[{"vehicle_id":"car-1","name":"First","subject":"device-sub-1"}],
		"operators":[{"user_id":"alice","tenant_id":"fleet-a","vehicle_id":"car-1","permissions":["observe"]}]
	}`))
	if err != nil {
		t.Fatalf("ParseAuthorizationPolicy() error = %v", err)
	}
	if _, ok := registry.byID["car-1"]; !ok {
		t.Fatal("vehicle was not registered")
	}
	if vehicleID, ok := identities.Resolve("device-sub-1"); !ok || vehicleID != "car-1" || !identities.Strict() {
		t.Fatalf("identity mapping = %q, %v, strict=%v; want car-1, true, true", vehicleID, ok, identities.Strict())
	}
	claims := &UserClaims{Name: "alice", Organization: "fleet-a", Roles: []string{"observer"}}
	if !authorizer.Authorize(claims, "car-1", ObservePermission) ||
		authorizer.Authorize(claims, "car-1", ControlPermission) {
		t.Fatal("operator ACL did not preserve observe-only access")
	}
}

func TestParseAuthorizationPolicyRejectsInvalidOrAmbiguousEntries(t *testing.T) {
	tests := []struct {
		name string
		raw  string
	}{
		{"missing arrays", `{}`},
		{"missing subject", `{"vehicles":[{"vehicle_id":"car-1","name":"First"}],"operators":[]}`},
		{"duplicate vehicle", `{"vehicles":[{"vehicle_id":"car-1","name":"First","subject":"sub-1"},{"vehicle_id":"car-1","name":"Again","subject":"sub-2"}],"operators":[]}`},
		{"duplicate subject", `{"vehicles":[{"vehicle_id":"car-1","name":"First","subject":"same"},{"vehicle_id":"car-2","name":"Second","subject":"same"}],"operators":[]}`},
		{"unknown ACL vehicle", `{"vehicles":[],"operators":[{"user_id":"alice","vehicle_id":"car-1","permissions":["observe"]}]}`},
		{"unknown field", `{"vehicles":[],"operators":[],"extra":true}`},
		{"duplicate field", `{"vehicles":[],"vehicles":[],"operators":[]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, _, _, err := ParseAuthorizationPolicy([]byte(test.raw)); err == nil {
				t.Fatal("ParseAuthorizationPolicy() error = nil, want rejection")
			}
		})
	}
}

func TestNewAuthorizationPolicyFromEnvironmentLoadsFileAndRejectsLegacyMix(t *testing.T) {
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(`{"vehicles":[],"operators":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AUTHORIZATION_POLICY_FILE", path)
	t.Setenv("VEHICLE_REGISTRY_JSON", "")
	t.Setenv("VEHICLE_SUBJECT_MAP_JSON", "")
	t.Setenv("VEHICLE_ACL_JSON", "")
	registry, identities, _, err := NewAuthorizationPolicyFromEnvironment()
	if err != nil {
		t.Fatalf("NewAuthorizationPolicyFromEnvironment() error = %v", err)
	}
	if len(registry.vehicles) != 0 || !identities.Strict() {
		t.Fatalf("empty policy should remain strict: vehicles=%d strict=%v", len(registry.vehicles), identities.Strict())
	}

	t.Setenv("VEHICLE_ACL_JSON", "[]")
	if _, _, _, err := NewAuthorizationPolicyFromEnvironment(); err == nil {
		t.Fatal("policy file and legacy ACL configuration were both accepted")
	}
}
