package gateway

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	"github.com/twitchtv/twirp"
)

type managedRequestClaims struct {
	installationOnly    bool
	installationSubject string
	installationClient  string
	registry            *VehicleRegistry
	deviceID            string
	permissions         map[string]map[VehiclePermission]bool
}

type ManagedRuntime struct {
	store         *authorization.Store
	db            *sql.DB
	instance      *sql.Conn
	issuer        string
	maintenance   bool
	mu            sync.RWMutex
	additiveMu    sync.Mutex
	observedUsers sync.Map
	roomsEmpty    func(context.Context) error
	rtcProxy      http.Handler
}

var (
	errManagedDenied      = errors.New("managed identity or organization is not authorized")
	errManagedAmbiguous   = errors.New("select an authorized organization with X-Organization-ID")
	errManagedMaintenance = errors.New("managed maintenance: new media and control are disabled")
	errManagedDrain       = errors.New("managed mutation requires maintenance and fully drained sessions and token expiry")
)

func managedAuthorizationConfigured() (bool, error) {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("AUTHORIZATION_MODE"))) {
	case "", "static":
		return false, nil
	case "managed":
	default:
		return false, errors.New("AUTHORIZATION_MODE must be static or managed")
	}
	if strings.ToLower(strings.TrimSpace(os.Getenv("AUTH_MODE"))) != "oidc" {
		return false, errors.New("managed authorization requires AUTH_MODE=oidc")
	}
	for _, name := range []string{"AUTHORIZATION_DATABASE_URL", "OIDC_ISSUER", "LIVEKIT_URL"} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			return false, fmt.Errorf("managed authorization requires %s", name)
		}
	}
	if os.Getenv("AUTHORIZATION_LIVEKIT_SERVER_VERSION") != "v1.13.11" ||
		os.Getenv("AUTHORIZATION_LIVEKIT_INGRESS_GATED") != "true" {
		return false, errors.New("managed authorization requires pinned LiveKit v1.13.11 and exclusively gated RTC ingress")
	}
	for _, name := range []string{"AUTHORIZATION_POLICY_FILE", "VEHICLE_REGISTRY_JSON", "VEHICLE_SUBJECT_MAP_JSON", "VEHICLE_ACL_JSON"} {
		if strings.TrimSpace(os.Getenv(name)) != "" {
			return false, fmt.Errorf("managed authorization cannot be mixed with %s", name)
		}
	}
	if value := os.Getenv("AUTHORIZATION_MANAGED_MAINTENANCE"); value != "" && value != "true" && value != "false" {
		return false, errors.New("AUTHORIZATION_MANAGED_MAINTENANCE must be true or false")
	}
	return true, nil
}

func NewManagedRuntimeFromEnvironment(ctx context.Context) (*ManagedRuntime, error) {
	enabled, err := managedAuthorizationConfigured()
	if err != nil || !enabled {
		return nil, err
	}
	db, err := sql.Open("pgx", os.Getenv("AUTHORIZATION_DATABASE_URL"))
	if err != nil {
		return nil, errors.New("open managed authorization database")
	}
	runtime := &ManagedRuntime{db: db, issuer: os.Getenv("OIDC_ISSUER"),
		maintenance: os.Getenv("AUTHORIZATION_MANAGED_MAINTENANCE") == "true"}
	success := false
	defer func() {
		if !success {
			runtime.Close()
		}
	}()
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := db.PingContext(startup); err != nil {
		return nil, errors.New("connect managed authorization database")
	}
	// The pilot deliberately supports one Gateway, not eventual cross-instance
	// policy propagation. A dedicated PostgreSQL session owns that boundary.
	runtime.instance, err = db.Conn(startup)
	if err != nil {
		return nil, errors.New("reserve managed authorization instance")
	}
	var locked bool
	if err := runtime.instance.QueryRowContext(startup,
		"SELECT pg_try_advisory_lock(7439102342056781)").Scan(&locked); err != nil || !locked {
		return nil, errors.New("managed authorization requires an exclusive single Gateway instance")
	}
	runtime.store, err = authorization.NewManagedStore(db, runtime.instance)
	if err != nil {
		return nil, err
	}
	if err := runtime.store.Migrate(startup); err != nil {
		return nil, err
	}
	runtime.roomsEmpty, err = managedRoomDrainCheck(os.Getenv("LIVEKIT_URL"))
	if err != nil {
		return nil, err
	}
	endpoint, _ := url.Parse(os.Getenv("LIVEKIT_URL"))
	switch endpoint.Scheme {
	case "ws":
		endpoint.Scheme = "http"
	case "wss":
		endpoint.Scheme = "https"
	}
	proxy := httputil.NewSingleHostReverseProxy(endpoint)
	proxy.Transport = &http.Transport{ResponseHeaderTimeout: 5 * time.Second, TLSHandshakeTimeout: 5 * time.Second}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, _ error) {
		writeManagedError(w, r, errors.New("LiveKit signaling unavailable"))
	}
	runtime.rtcProxy = proxy
	if !runtime.maintenance {
		if err := runtime.store.SetDrainQuietUntil(startup, time.Time{}); err != nil {
			return nil, err
		}
	}
	success = true
	return runtime, nil
}

func (m *ManagedRuntime) Close() {
	if m.instance != nil {
		// database/sql returns connections to its pool; explicitly release the
		// session lock before returning this one.
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, _ = m.instance.ExecContext(ctx, "SELECT pg_advisory_unlock(7439102342056781)")
		cancel()
		_ = m.instance.Close()
	}
	if m.db != nil {
		_ = m.db.Close()
	}
}

func (m *ManagedRuntime) authorizeRequest(r *http.Request, claims *UserClaims) (func(), error) {
	m.mu.RLock()
	release := m.mu.RUnlock
	fail := func(err error) (func(), error) {
		release()
		return nil, err
	}
	if claims.Issuer == "" || claims.Issuer != m.issuer {
		return fail(errManagedDenied)
	}
	if m.instance != nil {
		// A lost session loses the single-instance lock. Never silently acquire
		// a replacement connection or continue serving under that condition.
		m.additiveMu.Lock()
		err := m.instance.PingContext(r.Context())
		m.additiveMu.Unlock()
		if err != nil {
			return fail(fmt.Errorf("managed instance lock unavailable: %w", err))
		}
	}
	if m.maintenance && managedStartsSession(r) {
		return fail(errManagedMaintenance)
	}
	var bound *UserClaims
	var err error
	if strings.HasPrefix(r.URL.Path, "/api/admin/") {
		bound, err = m.resolveAdminClaims(r, claims)
	} else if r.URL.Path == "/api/organizations/context" ||
		(r.URL.Path == "/api/auth/me" && strings.TrimSpace(r.Header.Get("X-Organization-ID")) == "") {
		bound, err = m.resolveIdentityClaims(r.Context(), claims)
	} else {
		bound, err = m.resolveClaims(r.Context(), claims, strings.TrimSpace(r.Header.Get("X-Organization-ID")))
	}
	if errors.Is(err, errManagedDenied) {
		bound, err = m.installingClaims(r, claims)
	}
	if err != nil {
		return fail(err)
	}
	*claims = *bound
	if r.Method == http.MethodPost && (strings.HasPrefix(r.URL.Path, "/api/admin/") ||
		(strings.HasPrefix(r.URL.Path, "/api/vehicles/") && strings.HasSuffix(r.URL.Path, "/installation-complete"))) {
		// BeforeMutation obtains the exclusive lock and the Store rechecks the
		// administrator inside its transaction; avoid a read-to-write deadlock.
		release()
		return func() {}, nil
	}
	return release, nil
}

func (m *ManagedRuntime) resolveIdentityClaims(ctx context.Context, original *UserClaims) (*UserClaims, error) {
	userID, err := m.store.ResolveUser(ctx, original.Issuer, original.Name)
	if err != nil {
		if managedBindingMissing(err) {
			return m.resolveClaims(ctx, original, "")
		}
		return nil, err
	}
	if !hasScope(original.Scopes, "teleop:observe") {
		return nil, errManagedDenied
	}
	organizations, err := m.store.UserOrganizations(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(organizations) == 1 {
		return m.resolveClaims(ctx, original, organizations[0].OrganizationID)
	}
	// Identity bootstrap is not a resource authorization. Administrators must
	// reach the organization selector even when they have several memberships.
	return &UserClaims{Name: userID, UserID: userID, Issuer: m.issuer,
		Roles: []string{}, Scopes: []string{}, managed: &managedRequestClaims{
			registry: managedRegistry(nil),
		}}, nil
}

func (m *ManagedRuntime) resolveAdminClaims(r *http.Request, original *UserClaims) (*UserClaims, error) {
	if !hasScope(original.Scopes, "teleop:observe") {
		return nil, errManagedDenied
	}
	userID, err := m.store.ResolveUser(r.Context(), original.Issuer, original.Name)
	if err != nil {
		if managedBindingMissing(err) {
			return nil, errManagedDenied
		}
		return nil, err
	}
	management, err := m.store.ManagedContext(r.Context(), userID)
	if err != nil {
		if errors.Is(err, authorization.ErrNotOrganizationAdmin) {
			return nil, errManagedDenied
		}
		return nil, err
	}
	organizationID := ""
	if r.URL.Path != "/api/admin/context" {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 4 || parts[2] != "organizations" {
			return nil, errManagedDenied
		}
		organizationID = parts[3]
		available := false
		for _, organization := range management.Organizations {
			if organization.OrganizationID == organizationID {
				available = true
			}
		}
		if !available {
			return nil, errManagedDenied
		}
		if header := strings.TrimSpace(r.Header.Get("X-Organization-ID")); header != "" && header != organizationID {
			return nil, errManagedDenied
		}
	}
	return &UserClaims{Name: userID, UserID: userID, Issuer: m.issuer,
		Organization: organizationID, Roles: []string{}, Scopes: []string{},
		managed: &managedRequestClaims{registry: managedRegistry(nil)}}, nil
}

func (m *ManagedRuntime) resolveClaims(ctx context.Context, original *UserClaims, requestedOrg string) (*UserClaims, error) {
	userID, err := m.store.ResolveUser(ctx, original.Issuer, original.Name)
	if err != nil {
		if !managedBindingMissing(err) {
			return nil, err
		}
		device, deviceErr := m.store.ResolveVehicle(ctx, original.Issuer, original.Name)
		if deviceErr != nil {
			if managedBindingMissing(deviceErr) {
				return nil, errManagedDenied
			}
			return nil, deviceErr
		}
		if requestedOrg != "" && requestedOrg != device.OrganizationID {
			return nil, errManagedDenied
		}
		if !hasScope(original.Scopes, "teleop:vehicle") {
			return nil, errManagedDenied
		}
		if device.ClientID != "" && (original.TokenType != "access-token" ||
			len(original.Scopes) != 1 || !slices.Contains(original.Audiences, device.ClientID)) {
			return nil, errManagedDenied
		}
		registry := managedRegistry([]authorization.Vehicle{device})
		return &UserClaims{Name: device.VehicleID, Issuer: m.issuer, Organization: device.OrganizationID,
			Roles: []string{"vehicle"}, Scopes: []string{"teleop:vehicle"},
			managed: &managedRequestClaims{deviceID: device.VehicleID, registry: registry}}, nil
	}
	if !hasScope(original.Scopes, "teleop:observe") {
		return nil, errManagedDenied
	}
	organizations, err := m.store.UserOrganizations(ctx, userID)
	if err != nil {
		return nil, err
	}
	organizationID := requestedOrg
	if organizationID == "" {
		if len(organizations) == 0 {
			return nil, errManagedDenied
		}
		if len(organizations) != 1 {
			return nil, errManagedAmbiguous
		}
		organizationID = organizations[0].OrganizationID
	}
	available := false
	for _, organization := range organizations {
		if organization.OrganizationID == organizationID {
			available = true
		}
	}
	if !available {
		return nil, errManagedDenied
	}
	person, err := m.store.UserAssignment(ctx, userID, organizationID)
	if err != nil {
		if managedBindingMissing(err) {
			return nil, errManagedDenied
		}
		return nil, err
	}
	vehicles, err := m.store.ActiveOrganizationVehicles(ctx, organizationID)
	if err != nil {
		return nil, err
	}
	local := make([]authorization.Vehicle, 0)
	permissions := make(map[string]map[VehiclePermission]bool)
	for _, vehicle := range vehicles {
		if vehicle.OrganizationID != organizationID {
			continue
		}
		local = append(local, vehicle)
		permissions[vehicle.VehicleID] = make(map[VehiclePermission]bool)
		for permission, action := range map[VehiclePermission]string{
			VehicleReadPermission: authorization.ActionVehicleRead,
			ObservePermission:     authorization.ActionCameraLiveView,
			ControlPermission:     authorization.ActionRemoteControl,
		} {
			allowed, err := m.store.Enforce(ctx, userID, organizationID, vehicle.VehicleID, action)
			if err != nil {
				return nil, err
			}
			permissions[vehicle.VehicleID][permission] = allowed
		}
	}
	roles := []string{}
	if person.Role != "" {
		roles = append(roles, string(person.Role))
	}
	return &UserClaims{Name: userID, UserID: userID, Issuer: m.issuer, Organization: organizationID,
		Roles: roles, Scopes: []string{}, managed: &managedRequestClaims{
			registry: managedRegistry(local), permissions: permissions,
		}}, nil
}

func managedBindingMissing(err error) bool {
	return errors.Is(err, sql.ErrNoRows) || errors.Is(err, authorization.ErrUnknownIdentity) ||
		errors.Is(err, authorization.ErrInactiveLifecycle)
}

func managedRegistry(vehicles []authorization.Vehicle) *VehicleRegistry {
	registry := &VehicleRegistry{vehicles: make([]RegisteredVehicle, 0, len(vehicles)),
		byID: make(map[string]RegisteredVehicle, len(vehicles))}
	for _, vehicle := range vehicles {
		entry := RegisteredVehicle{VehicleID: vehicle.VehicleID, Name: vehicle.Name}
		registry.vehicles = append(registry.vehicles, entry)
		registry.byID[entry.VehicleID] = entry
	}
	return registry
}

func requestVehicleRegistry(r *http.Request, fallback *VehicleRegistry) *VehicleRegistry {
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims != nil && claims.managed != nil {
		return claims.managed.registry
	}
	return fallback
}

func resolveVehicleClaims(claims *UserClaims, fallback *VehicleIdentityResolver) (string, bool) {
	if claims != nil && claims.managed != nil {
		return claims.managed.deviceID, claims.managed.deviceID != ""
	}
	if fallback == nil || claims == nil {
		return "", false
	}
	return fallback.Resolve(claims.Name)
}

func managedStartsSession(r *http.Request) bool {
	path := r.URL.Path
	if path == "/api/token/operator" || path == "/api/token/vehicle" {
		return true
	}
	if r.Method != http.MethodPost {
		return false
	}
	return (strings.Contains(path, "/control/") || strings.Contains(path, "/viewing/") ||
		strings.Contains(path, "/video/")) &&
		(strings.HasSuffix(path, "/acquire") || strings.HasSuffix(path, "/renew"))
}

func reserveManagedToken(w http.ResponseWriter, r *http.Request, token string) bool {
	claims, _ := r.Context().Value("user").(*UserClaims)
	if claims == nil || claims.managed == nil {
		return true
	}
	if managedRuntime == nil || managedRuntime.maintenance {
		writeManagedError(w, r, errManagedMaintenance)
		return false
	}
	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		writeManagedError(w, r, err)
		return false
	}
	tokenClaims, _, err := verifier.Verify(lkApiSecret)
	if err != nil || tokenClaims.Expiry == nil {
		writeManagedError(w, r, errors.New("minted media token has invalid expiry"))
		return false
	}
	// Persist the actual signed expiry before returning the token, including a
	// clock-skew margin. A failed response can only extend the drain interval.
	managedRuntime.additiveMu.Lock()
	defer managedRuntime.additiveMu.Unlock()
	if err := managedRuntime.store.SetDrainQuietUntil(r.Context(), time.Time{}); err != nil {
		writeManagedError(w, r, err)
		return false
	}
	expiry := tokenClaims.Expiry.Time().Add(time.Minute)
	var persistErr error
	if managedRuntime.instance != nil {
		persistErr = managedRuntime.store.RecordTokenExpiryOn(r.Context(), managedRuntime.instance, claims.Organization, expiry)
	} else {
		persistErr = managedRuntime.store.RecordTokenExpiry(r.Context(), claims.Organization, expiry)
	}
	if persistErr != nil {
		writeManagedError(w, r, persistErr)
		return false
	}
	return true
}

func writeManagedError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, errManagedDenied):
		writeDiagnosticError(w, r, err.Error(), "MANAGED_ACCESS_DENIED", http.StatusForbidden)
	case errors.Is(err, errManagedAmbiguous):
		writeDiagnosticError(w, r, err.Error(), "MANAGED_ORGANIZATION_REQUIRED", http.StatusConflict)
	case errors.Is(err, errManagedMaintenance), errors.Is(err, errManagedDrain):
		writeDiagnosticError(w, r, err.Error(), "MANAGED_MAINTENANCE_REQUIRED", http.StatusServiceUnavailable)
	default:
		writeDiagnosticError(w, r, "managed authorization service unavailable", "MANAGED_AUTHORIZATION_UNAVAILABLE", http.StatusServiceUnavailable)
	}
}

func (m *ManagedRuntime) BeforeMutation(ctx context.Context, _ string) (func(), error) {
	if !m.maintenance {
		return nil, errManagedDrain
	}
	m.mu.Lock()
	if err := m.checkDrained(ctx); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	return m.mu.Unlock, nil
}

// Fresh-identity transactions cannot revoke existing authority. Unlike the
// maintenance gate, this guard must coexist with long-lived RTC readers.
func (m *ManagedRuntime) BeforeAdditive(ctx context.Context, _ string) (func(), error) {
	m.mu.RLock()
	m.additiveMu.Lock()
	release := func() {
		m.additiveMu.Unlock()
		m.mu.RUnlock()
	}
	if err := ctx.Err(); err != nil {
		release()
		return nil, err
	}
	if m.instance != nil {
		if err := m.instance.PingContext(ctx); err != nil {
			release()
			return nil, fmt.Errorf("managed instance lock unavailable: %w", err)
		}
	}
	return release, nil
}

func (m *ManagedRuntime) checkDrained(ctx context.Context) error {
	if m.instance != nil {
		if err := m.instance.PingContext(ctx); err != nil {
			return fmt.Errorf("managed instance lock unavailable: %w", err)
		}
	}
	if !m.maintenance {
		return errManagedDrain
	}
	if controlLeases == nil || videoSessions == nil || m.roomsEmpty == nil {
		return errors.New("managed drain dependencies unavailable")
	}
	client := controlLeases.client
	for _, pattern := range []string{"control:*", "operator-control:*", "control-handover:*",
		"video_session:*", "video_viewer:*", "viewing:*:active"} {
		var cursor uint64
		for {
			keys, next, err := client.Scan(ctx, cursor, pattern, 100).Result()
			if err != nil {
				return err
			}
			for _, key := range keys {
				switch {
				case strings.HasPrefix(key, "control-handover:"):
					handover, err := controlLeases.GetHandover(ctx, strings.TrimPrefix(key, "control-handover:"))
					if err != nil {
						return err
					}
					if handover.State != "CONFIRMED" && handover.State != "NONE" {
						return errManagedDrain
					}
				case strings.HasPrefix(key, "video_session:"):
					session, err := videoSessions.Get(ctx, strings.TrimPrefix(key, "video_session:"))
					if err != nil {
						return err
					}
					if session.ViewerCount != 0 || session.ControllerSessionID != "" || session.Mode != VideoStandby {
						return errManagedDrain
					}
				case strings.HasPrefix(key, "viewing:"):
					vehicleID := strings.TrimSuffix(strings.TrimPrefix(key, "viewing:"), ":active")
					demand, err := (&ViewingLeaseStore{client: client}).Demand(ctx, vehicleID)
					if err != nil {
						return err
					}
					if demand.RTCRequired || demand.VideoRequired || demand.ViewerCount != 0 || demand.ControlRequired {
						return errManagedDrain
					}
				default:
					return errManagedDrain
				}
			}
			cursor = next
			if cursor == 0 {
				break
			}
		}
	}
	if err := m.roomsEmpty(ctx); err != nil {
		if clearErr := m.store.SetDrainQuietUntil(ctx, time.Time{}); clearErr != nil {
			return clearErr
		}
		return err
	}
	quietUntil, err := m.store.DrainQuietUntil(ctx)
	if err != nil {
		return err
	}
	if quietUntil.IsZero() {
		// LiveKit v1.13.11 refreshes reconnect JWTs for ten minutes. Empty
		// rooms alone are not revocation: wait out those refreshed credentials
		// with all signaling ingress closed, plus a clock-skew margin.
		quietUntil = time.Now().Add(11 * time.Minute)
		if err := m.store.SetDrainQuietUntil(ctx, quietUntil); err != nil {
			return err
		}
	}
	horizon, err := m.store.TokenExpiry(ctx, "")
	if err != nil {
		return err
	}
	if horizon.After(quietUntil) {
		quietUntil = horizon
	}
	if time.Now().Before(quietUntil) {
		return fmt.Errorf("%w: issued and server-refreshed LiveKit tokens require waiting until %s",
			errManagedDrain, quietUntil.UTC().Format(time.RFC3339))
	}
	return nil
}

// RTCIngress must be the exclusive public signaling route in the managed
// deployment. It gates initial joins and reconnects, not just token issuance.
func (m *ManagedRuntime) RTCIngress(w http.ResponseWriter, r *http.Request) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.maintenance || m.rtcProxy == nil {
		writeManagedError(w, r, errManagedMaintenance)
		return
	}
	err := func() error {
		m.additiveMu.Lock()
		defer m.additiveMu.Unlock()
		if m.instance != nil {
			if err := m.instance.PingContext(r.Context()); err != nil {
				return err
			}
		}
		return m.store.SetDrainQuietUntil(r.Context(), time.Time{})
	}()
	if err != nil {
		writeManagedError(w, r, err)
		return
	}
	// ServeHTTP retains the shared guard through the complete websocket
	// lifetime, including the upgrade, so no approved handshake can outlive
	// the drain barrier unnoticed.
	m.rtcProxy.ServeHTTP(w, r)
}

func managedRoomDrainCheck(rawURL string) (func(context.Context) error, error) {
	endpoint, err := url.Parse(rawURL)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" ||
		endpoint.Fragment != "" {
		return nil, errors.New("managed authorization requires a valid LIVEKIT_URL")
	}
	switch endpoint.Scheme {
	case "ws":
		endpoint.Scheme = "http"
	case "wss":
		endpoint.Scheme = "https"
	case "http", "https":
	default:
		return nil, errors.New("managed authorization requires HTTP(S) or WS(S) LIVEKIT_URL")
	}
	service := livekit.NewRoomServiceProtobufClient(endpoint.String(), &http.Client{Timeout: 5 * time.Second})
	return func(ctx context.Context) error {
		if lkApiKey == "" || lkApiSecret == "" {
			return errors.New("LiveKit drain credentials unavailable")
		}
		token, err := auth.NewAccessToken(lkApiKey, lkApiSecret).
			AddGrant(&auth.VideoGrant{RoomList: true}).SetValidFor(30 * time.Second).ToJWT()
		if err != nil {
			return err
		}
		headers := make(http.Header)
		headers.Set("Authorization", "Bearer "+token)
		ctx, err = twirp.WithHTTPRequestHeaders(ctx, headers)
		if err != nil {
			return err
		}
		rooms, err := service.ListRooms(ctx, &livekit.ListRoomsRequest{})
		if err != nil {
			return err
		}
		for _, room := range rooms.Rooms {
			if strings.HasPrefix(room.Name, "teleop-") {
				return errManagedDrain
			}
		}
		return nil
	}, nil
}

func (m *ManagedRuntime) observeAuthenticatedUser(ctx context.Context, user string) {
	if _, seen := m.observedUsers.Load(user); seen {
		return
	}
	if err := m.store.RecordAuthenticatedUser(ctx, user); err == nil {
		m.observedUsers.Store(user, true)
	}
}
