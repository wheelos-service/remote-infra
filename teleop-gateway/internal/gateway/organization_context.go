package gateway

import (
	"net/http"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func registerStaticOrganizationContext(mux *http.ServeMux, registry *VehicleRegistry, authorizer *VehicleAuthorizer) {
	mux.Handle("GET /api/organizations/context", AuthenticationMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		claims := r.Context().Value("user").(*UserClaims)
		controlVehicles := []string{}
		if registry != nil && authorizer != nil && canControl(claims) {
			for _, vehicle := range registry.vehicles {
				if authorizer.Authorize(claims, vehicle.VehicleID, ControlPermission) {
					controlVehicles = append(controlVehicles, vehicle.VehicleID)
				}
			}
		}
		// Static tenants are not managed organization memberships or UUIDs.
		writeJSON(w, http.StatusOK, struct {
			Mode              string                             `json:"mode"`
			Organizations     []authorization.MemberOrganization `json:"organizations"`
			ControlVehicleIDs []string                           `json:"control_vehicle_ids"`
		}{
			Mode: "static", Organizations: []authorization.MemberOrganization{},
			ControlVehicleIDs: controlVehicles,
		})
	})))
}
