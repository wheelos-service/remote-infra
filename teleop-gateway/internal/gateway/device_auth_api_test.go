package gateway

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

type deviceAuthTestAuthenticator map[string]*UserClaims

func (a deviceAuthTestAuthenticator) Authenticate(_ context.Context, token string) (*UserClaims, error) {
	if claims, ok := a[token]; ok {
		return claims, nil
	}
	return nil, ErrInvalidToken
}

func TestHandleDeviceAuthCheckRequiresRegisteredMatchingDevice(t *testing.T) {
	oldRegistry, oldIdentities, oldAuthenticator := vehicleRegistry, vehicleIdentities, authenticator
	vehicleRegistry = &VehicleRegistry{byID: map[string]RegisteredVehicle{
		"car-1": {VehicleID: "car-1", Name: "First"},
	}}
	vehicleIdentities = &VehicleIdentityResolver{
		bySubject: map[string]string{
			"device-sub-1": "car-1",
			"device-sub-2": "car-2",
		},
		strict: true,
	}
	authenticator = deviceAuthTestAuthenticator{
		"device":              {Name: "device-sub-1", Roles: []string{"vehicle"}},
		"other-device":        {Name: "other-sub", Roles: []string{"vehicle"}},
		"unregistered-device": {Name: "device-sub-2", Roles: []string{"vehicle"}},
		"not-vehicle":         {Name: "device-sub-1", Roles: []string{"observer"}},
	}
	t.Cleanup(func() {
		vehicleRegistry, vehicleIdentities, authenticator = oldRegistry, oldIdentities, oldAuthenticator
	})
	mux := http.NewServeMux()
	registerDeviceAuthCheck(mux)

	tests := []struct {
		name       string
		vehicleID  string
		token      string
		wantStatus int
	}{
		{"matching device", "car-1", "device", http.StatusNoContent},
		{"wrong device", "car-1", "other-device", http.StatusForbidden},
		{"not a vehicle identity", "car-1", "not-vehicle", http.StatusForbidden},
		{"unregistered vehicle", "car-2", "device", http.StatusForbidden},
		{"mapped but unregistered vehicle", "car-2", "unregistered-device", http.StatusNotFound},
		{"invalid bearer", "car-1", "invalid", http.StatusUnauthorized},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/vehicles/"+test.vehicleID+"/device-auth-check", nil)
			request.Header.Set("Authorization", "Bearer "+test.token)
			response := httptest.NewRecorder()
			mux.ServeHTTP(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%q", response.Code, test.wantStatus, response.Body.String())
			}
			if test.wantStatus == http.StatusNoContent && response.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("successful device auth check is cacheable")
			}
		})
	}
}
