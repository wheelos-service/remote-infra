package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
)

func (api *ManagedAdminAPI) registerLifecycle(mux *http.ServeMux, authenticate func(http.Handler) http.Handler) {
	for _, pattern := range []string{
		"POST /api/admin/organizations/{org_id}/members/{user_id}/remove",
		"POST /api/admin/organizations/{org_id}/members/{user_id}/rejoin",
		"POST /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/remove",
		"POST /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/reactivate",
		"POST /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/transfer",
		"POST /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/credential-revocations",
		"POST /api/admin/organizations/{org_id}/vehicles/{vehicle_id}/credential-rotations",
		"GET /api/admin/organizations/{org_id}/lifecycle-operations",
		"GET /api/admin/organizations/{org_id}/lifecycle-operations/{operation_id}",
		"POST /api/admin/organizations/{org_id}/lifecycle-operations/{operation_id}/retry",
		"POST /api/admin/organizations/{org_id}/lifecycle-operations/{operation_id}/confirm",
	} {
		mux.Handle(pattern, authenticate(http.HandlerFunc(api.serveLifecycle)))
	}
}

func (api *ManagedAdminAPI) serveLifecycle(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims == nil || claims.UserID == "" || claims.Issuer != api.TrustedIssuer {
		writeDiagnosticError(w, r, "a bound human identity is required", "MANAGED_IDENTITY_REQUIRED", http.StatusForbidden)
		return
	}
	if api.Store == nil {
		managedAdminError(w, r, errors.New("store unavailable"))
		return
	}
	org := r.PathValue("org_id")
	if !onboardingUUID(org) {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	allowed, err := api.Store.CanManageOrganization(r.Context(), claims.UserID, org)
	if err != nil {
		managedAdminError(w, r, err)
		return
	}
	if !allowed {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	if r.Method == http.MethodGet {
		if id := r.PathValue("operation_id"); id != "" {
			op, err := api.Store.GetLifecycle(r.Context(), claims.UserID, org, id)
			if err != nil {
				managedAdminError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, op)
		} else {
			ops, err := api.Store.ListLifecycle(r.Context(), claims.UserID, org)
			if err != nil {
				managedAdminError(w, r, err)
				return
			}
			writeJSON(w, http.StatusOK, ops)
		}
		return
	}
	var in authorization.LifecycleRequest
	if err := decodeManagedBody(w, r, &in, "idempotency_key", "expected_version", "reason", "verified_subject", "destination_org_id"); err != nil {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	if api.Onboarding != nil {
		api.Onboarding.workMu.Lock()
		defer api.Onboarding.workMu.Unlock()
	}
	if api.BeforeMutation == nil {
		writeDiagnosticError(w, r, "management drain guard is unavailable", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		return
	}
	release, err := api.BeforeMutation(r.Context(), org)
	if err != nil || release == nil {
		if errors.Is(err, errManagedDrain) || errors.Is(err, errManagedMaintenance) {
			writeDiagnosticError(w, r, "management requires maintenance and fully drained sessions", "MANAGED_DRAIN_REQUIRED", http.StatusConflict)
		} else {
			writeDiagnosticError(w, r, "management drain verification is unavailable", "MANAGED_DRAIN_UNAVAILABLE", http.StatusServiceUnavailable)
		}
		return
	}
	defer release()
	if id := r.PathValue("operation_id"); id != "" {
		if !onboardingUUID(id) {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		action := "retry"
		if strings.HasSuffix(r.URL.Path, "/confirm") {
			action = "confirm"
		}
		if err := api.Store.ReconcileLifecycle(r.Context(), claims.UserID, org, id, action, in.Reason); err != nil {
			managedAdminError(w, r, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	target := r.PathValue("user_id")
	action := "member_remove"
	if target != "" {
		if strings.HasSuffix(r.URL.Path, "/rejoin") {
			action = "member_rejoin"
		}
	} else {
		target = r.PathValue("vehicle_id")
		action = "vehicle_remove"
		if strings.HasSuffix(r.URL.Path, "/reactivate") {
			action = "vehicle_reactivate"
		}
		if strings.HasSuffix(r.URL.Path, "/transfer") {
			action = "vehicle_transfer"
		}
		if strings.HasSuffix(r.URL.Path, "/credential-revocations") {
			action = "credential_revoke"
		}
	}
	var ciphertext []byte
	if strings.HasSuffix(r.URL.Path, "/credential-rotations") {
		action = "credential_rotate"
		if api.Onboarding == nil {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		secret, e := onboardingRandom()
		if e != nil {
			onboardingHTTPError(w, r, e)
			return
		}
		ciphertext, e = api.Onboarding.encryptCredential(secret)
		if e != nil {
			onboardingHTTPError(w, r, e)
			return
		}
	}
	op, err := api.Store.Lifecycle(r.Context(), claims.UserID, org, target, action, in, api.Onboarding != nil, ciphertext)
	if err != nil {
		managedAdminError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, op)
}

func (s *OnboardingService) revokeProviderCredential(ctx context.Context, op authorization.RevocationWork) error {
	identity := authorization.OnboardingOperation{ProviderName: op.ProviderName, ClientID: op.ClientID}
	raw, err := s.reconcileVehicle(ctx, identity)
	if err != nil {
		return err
	}
	if raw == nil {
		return nil
	}
	secret, err := onboardingRandom()
	if err != nil {
		return onboardingProviderUnavailable
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return onboardingProviderConflict
	}
	encoded, err := json.Marshal(secret)
	if err != nil {
		return onboardingProviderRejected
	}
	fields["clientSecret"] = encoded
	_, updateErr := s.providerRequest(ctx, http.MethodPost, "/api/update-application?id="+url.QueryEscape("admin/"+op.ProviderName), fields)
	updated, err := s.reconcileVehicle(ctx, identity)
	if err != nil {
		return err
	}
	if updated == nil {
		return nil
	}
	var confirmation struct {
		ClientSecret string `json:"clientSecret"`
	}
	if json.Unmarshal(updated, &confirmation) != nil {
		return onboardingProviderConflict
	}
	if confirmation.ClientSecret != secret {
		if updateErr != nil {
			return updateErr
		}
		return onboardingProviderConflict
	}
	return nil
}

func (s *OnboardingService) processRevocation(ctx context.Context) {
	op, err := s.store.NextRevocation(ctx)
	if err != nil {
		return
	}
	attempt, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()
	err = s.revokeProviderCredential(attempt, op)
	code := ""
	if err != nil {
		code = onboardingSafeFailure(err)
	}
	recovery, stop := context.WithTimeout(ctx, 5*time.Second)
	defer stop()
	_ = s.mutate(recovery, op.OrganizationID, func() error { return s.store.RecordRevocation(recovery, op, code) })
}
