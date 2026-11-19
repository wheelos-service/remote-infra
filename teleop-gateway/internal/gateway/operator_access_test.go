package gateway

import "testing"

func TestResolveOperatorAccess(t *testing.T) {
	tests := []struct {
		name      string
		roles     []string
		requested string
		want      OperatorAccess
		wantErr   bool
	}{
		{
			name: "observer defaults to observer",
			roles: []string{"observer"},
			want:  ObserverAccess,
		},
		{
			name: "observer cannot request controller",
			roles: []string{"observer"},
			requested: string(ControllerAccess),
			wantErr: true,
		},
		{
			name: "controller defaults to controller",
			roles: []string{"controller"},
			want:  ControllerAccess,
		},
		{
			name: "controller can request observer",
			roles: []string{"controller"},
			requested: string(ObserverAccess),
			want:      ObserverAccess,
		},
		{
			name: "legacy operator remains controller during migration",
			roles: []string{"operator"},
			want:  ControllerAccess,
		},
		{
			name: "unsupported access is rejected",
			roles: []string{"controller"},
			requested: "invalid",
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := resolveOperatorAccess(&UserClaims{Roles: test.roles}, test.requested)
			if test.wantErr {
				if err == nil {
					t.Fatal("resolveOperatorAccess() error = nil, want error")
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveOperatorAccess() error = %v", err)
			}
			if got != test.want {
				t.Fatalf("resolveOperatorAccess() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestOperatorVideoGrant(t *testing.T) {
	observer := operatorVideoGrant("vehicle-001", ObserverAccess)
	if observer.CanPublishData == nil || *observer.CanPublishData {
		t.Fatal("observer grant must not publish data")
	}

	controller := operatorVideoGrant("vehicle-001", ControllerAccess)
	if controller.CanPublishData == nil || !*controller.CanPublishData {
		t.Fatal("controller grant must publish data")
	}
	if controller.Room != "teleop-vehicle-001" || !controller.RoomJoin ||
		controller.CanSubscribe == nil || !*controller.CanSubscribe {
		t.Fatal("controller grant must be scoped to the requested vehicle room")
	}
}
