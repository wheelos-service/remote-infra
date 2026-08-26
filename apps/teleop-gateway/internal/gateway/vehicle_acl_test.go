package gateway

import "testing"

func TestVehicleAuthorizer(t *testing.T) {
	authorizer, err := NewVehicleAuthorizer([]VehicleACL{
		{
			UserID: "operator-001", TenantID: "fleet-a", VehicleID: "vehicle-001",
			Permissions: []VehiclePermission{ObservePermission},
		},
		{
			UserID: "controller-001", TenantID: "fleet-a", VehicleID: "vehicle-001",
			Permissions: []VehiclePermission{ControlPermission},
		},
	})
	if err != nil {
		t.Fatalf("NewVehicleAuthorizer() error = %v", err)
	}

	observer := &UserClaims{Name: "operator-001", Organization: "fleet-a"}
	if !authorizer.Authorize(observer, "vehicle-001", ObservePermission) {
		t.Fatal("observer should have observe permission")
	}
	if authorizer.Authorize(observer, "vehicle-001", ControlPermission) {
		t.Fatal("observer must not have control permission")
	}
	if authorizer.Authorize(observer, "vehicle-002", ObservePermission) {
		t.Fatal("ACL must not authorize a different vehicle")
	}

	controller := &UserClaims{Name: "controller-001", Organization: "fleet-a"}
	if !authorizer.Authorize(controller, "vehicle-001", ControlPermission) || !authorizer.Authorize(controller, "vehicle-001", ObservePermission) {
		t.Fatal("control permission should include observation")
	}
	if authorizer.Authorize(&UserClaims{Name: "controller-001", Organization: "fleet-b"}, "vehicle-001", ObservePermission) {
		t.Fatal("tenant mismatch must be denied")
	}
}

func TestVehicleAuthorizerRejectsInvalidEntries(t *testing.T) {
	if _, err := NewVehicleAuthorizer([]VehicleACL{{UserID: "operator-001", VehicleID: "vehicle-001"}}); err == nil {
		t.Fatal("NewVehicleAuthorizer() accepted an entry without permissions")
	}
	if _, err := NewVehicleAuthorizer([]VehicleACL{{
		UserID: "operator-001", VehicleID: "vehicle-001", Permissions: []VehiclePermission{"delete"},
	}}); err == nil {
		t.Fatal("NewVehicleAuthorizer() accepted an unsupported permission")
	}
}