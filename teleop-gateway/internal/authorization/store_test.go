package authorization

import (
	"strings"
	"testing"
)

const (
	testUserID = "11111111-1111-4111-8111-111111111111"
	testOrgID  = "22222222-2222-4222-8222-222222222222"
	testGrant  = "grant:33333333-3333-4333-8333-333333333333"
)

func TestCasbinRoleAndVehicleScopeAreConjunctive(t *testing.T) {
	tests := []struct {
		name         string
		role         Role
		scope        Scope
		vehicles     []string
		organization string
		vehicle      string
		action       string
		want         bool
	}{
		{
			name: "no operation scope still reads new vehicles",
			role: RoleViewer, scope: ScopeNone,
			organization: testOrgID, vehicle: "car-new", action: ActionVehicleRead, want: true,
		},
		{
			name: "selected operator monitors vehicles outside operation scope",
			role: RoleRemoteOperator, scope: ScopeSelected, vehicles: []string{"car-a"},
			organization: testOrgID, vehicle: "car-new", action: ActionCameraLiveView, want: true,
		},
		{
			name: "organization admin receives live viewing baseline",
			role: RoleOrgAdmin, scope: ScopeAll,
			organization: testOrgID, vehicle: "car-new", action: ActionCameraLiveView, want: true,
		},
		{
			name: "no operation scope cannot execute tasks",
			role: RoleDispatcher, scope: ScopeNone,
			organization: testOrgID, vehicle: "car-a", action: ActionTaskManage,
		},
		{
			name: "unassigned operator cannot control",
			role: RoleRemoteOperator, scope: ScopeNone,
			organization: testOrgID, vehicle: "car-a", action: ActionRemoteControl,
		},
		{
			name: "selected control vehicle",
			role: RoleRemoteOperator, scope: ScopeSelected, vehicles: []string{"car-a"},
			organization: testOrgID, vehicle: "car-a", action: ActionRemoteControl, want: true,
		},
		{
			name: "selected does not include another vehicle",
			role: RoleRemoteOperator, scope: ScopeSelected, vehicles: []string{"car-a"},
			organization: testOrgID, vehicle: "car-b", action: ActionRemoteControl,
		},
		{
			name: "domain does not cross organizations",
			role: RoleRemoteOperator, scope: ScopeAll,
			organization: "44444444-4444-4444-8444-444444444444", vehicle: "car-a", action: ActionRemoteControl,
		},
		{
			name: "viewer cannot control",
			role: RoleViewer, scope: ScopeAll,
			organization: testOrgID, vehicle: "car-a", action: ActionRemoteControl,
		},
		{
			name: "org admin does not inherit control",
			role: RoleOrgAdmin, scope: ScopeAll,
			organization: testOrgID, vehicle: "car-a", action: ActionRemoteControl,
		},
		{
			name: "all scope includes future matching resources",
			role: RoleViewer, scope: ScopeAll,
			organization: testOrgID, vehicle: "car-new", action: ActionVehicleRead, want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assignment := Assignment{
				UserID: testUserID, OrganizationID: testOrgID,
				Role: tt.role, Scope: tt.scope, VehicleIDs: tt.vehicles,
			}
			snapshot, err := buildSnapshot(1, assignmentRules(assignment, testGrant))
			if err != nil {
				t.Fatal(err)
			}
			got, err := snapshot.enforcer.Enforce(
				"user:"+testUserID,
				"org:"+tt.organization,
				tt.vehicle,
				tt.action,
				tt.organization == testOrgID,
			)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("Enforce() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSnapshotRejectsUnboundOrExpandedPolicies(t *testing.T) {
	valid := assignmentRules(Assignment{
		UserID: testUserID, OrganizationID: testOrgID, Role: RoleViewer, Scope: ScopeAll,
	}, testGrant)
	policies := append([]policyRule(nil), valid...)
	policies = append(policies, policyRule{
		kind: "p",
		values: []string{
			"org:" + testOrgID, testGrant, "role:viewer",
			ActionRemoteControl, string(ScopeAll), "*",
		},
	})
	if _, err := buildSnapshot(1, policies); err == nil || !strings.Contains(err.Error(), "fixed role capabilities") {
		t.Fatalf("buildSnapshot() error = %v, want fixed capability rejection", err)
	}

	directRoleGrant := []policyRule{
		{kind: "g", values: []string{"user:" + testUserID, "role:org_admin", "org:" + testOrgID}},
	}
	if _, err := buildSnapshot(1, directRoleGrant); err == nil {
		t.Fatal("buildSnapshot() accepted a direct user-to-role grant")
	}
}

func TestAssignmentInputRejectsArbitraryRolesAndAmbiguousScopes(t *testing.T) {
	base := Assignment{
		ActorUserID: "55555555-5555-4555-8555-555555555555",
		UserID:      testUserID, OrganizationID: testOrgID,
		Role: RoleViewer, Scope: ScopeAll,
	}
	for _, tc := range []struct {
		name string
		edit func(*Assignment)
	}{
		{name: "unknown role", edit: func(a *Assignment) { a.Role = Role("custom") }},
		{name: "unassigned with vehicles", edit: func(a *Assignment) { a.Scope, a.VehicleIDs = ScopeNone, []string{"car-a"} }},
		{name: "unassigned organization administrator", edit: func(a *Assignment) { a.Role, a.Scope = RoleOrgAdmin, ScopeNone }},
		{name: "all with selected vehicle", edit: func(a *Assignment) { a.VehicleIDs = []string{"car-a"} }},
		{name: "selected without vehicle", edit: func(a *Assignment) { a.Scope = ScopeSelected }},
		{name: "selected wildcard", edit: func(a *Assignment) { a.Scope, a.VehicleIDs = ScopeSelected, []string{"*"} }},
		{name: "duplicate selected vehicle", edit: func(a *Assignment) { a.Scope, a.VehicleIDs = ScopeSelected, []string{"car-a", "car-a"} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assignment := base
			assignment.VehicleIDs = append([]string(nil), base.VehicleIDs...)
			tc.edit(&assignment)
			if _, err := normalizeAssignment(assignment); err == nil {
				t.Fatal("normalizeAssignment() accepted invalid input")
			}
		})
	}
}

func TestNormalizeAssignmentDoesNotMutateCallerVehicleIDs(t *testing.T) {
	vehicles := []string{"car-z", "car-a"}
	assignment := Assignment{
		ActorUserID: "55555555-5555-4555-8555-555555555555",
		UserID:      testUserID, OrganizationID: testOrgID,
		Role: RoleViewer, Scope: ScopeSelected, VehicleIDs: vehicles,
	}
	normalized, err := normalizeAssignment(assignment)
	if err != nil {
		t.Fatal(err)
	}
	if vehicles[0] != "car-z" || vehicles[1] != "car-a" {
		t.Fatalf("normalizeAssignment mutated caller slice: %v", vehicles)
	}
	if normalized.VehicleIDs[0] != "car-a" || normalized.VehicleIDs[1] != "car-z" {
		t.Fatalf("normalized VehicleIDs = %v, want sorted copy", normalized.VehicleIDs)
	}
	normalized.VehicleIDs[0] = "changed"
	if vehicles[1] != "car-a" {
		t.Fatalf("normalized slice aliases caller slice: %v", vehicles)
	}
}
