package gateway

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/webhook"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ==========================================
// 1. Configuration and component initialization
// ==========================================

var (
	lkApiKey          = os.Getenv("LIVEKIT_API_KEY")
	lkApiSecret       = os.Getenv("LIVEKIT_API_SECRET")
	controlLeases     *ControlLeaseStore
	videoSessions     *VideoSessionStore
	authenticator     Authenticator
	vehicleAuthorizer *VehicleAuthorizer
	vehicleIdentities *VehicleIdentityResolver
	auditSink         AuditSink

	teleopAuthFailuresTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "teleop_auth_failures_total",
		Help: "Total number of failed Gateway authentication attempts",
	})
	teleopE2eLatencyP99 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "teleop_e2e_latency_p99_milliseconds",
		Help: "P99 end-to-end remote-control command latency in milliseconds",
	}, []string{"vehicle_id"})
)

type UserClaims struct {
	Name         string
	Roles        []string
	Scopes       []string
	Organization string
}

func init() {
	// Development uses a compact token parser. Production must validate
	// Casdoor/OIDC JWT signatures before creating UserClaims.
}

// ==========================================
// 2. HTTP routes and middleware
// ==========================================
func Run() {
	var err error
	authenticator, err = NewAuthenticatorFromEnvironment()
	if err != nil {
		log.Fatalf("configure authenticator: %v", err)
	}
	vehicleAuthorizer, err = NewVehicleAuthorizerFromEnvironment()
	if err != nil {
		log.Fatalf("configure vehicle ACL: %v", err)
	}
	vehicleIdentities, err = NewVehicleIdentityResolverFromEnvironment()
	if err != nil {
		log.Fatalf("configure vehicle identity map: %v", err)
	}
	auditSink = NewJSONAuditSink(os.Stdout)
	controlLeases, err = NewControlLeaseStore(
		os.Getenv("REDIS_URL"),
		controlLeaseTTL(),
	)
	if err != nil {
		log.Fatalf("configure control lease store: %v", err)
	}
	if err := controlLeases.Ping(context.Background()); err != nil {
		log.Fatalf("connect control lease store: %v", err)
	}
	videoSessions = NewVideoSessionStore(controlLeases.client, videoGracePeriod())

	mux := http.NewServeMux()

	// All operator and vehicle endpoints use the same authentication middleware.
	mux.Handle("/api/token/operator", AuthenticationMiddleware(http.HandlerFunc(handleOperatorConnect)))
	mux.Handle("/api/token/vehicle", AuthenticationMiddleware(http.HandlerFunc(handleVehicleConnect)))
	mux.Handle("POST /api/vehicles/{vehicle_id}/control/acquire", AuthenticationMiddleware(http.HandlerFunc(handleAcquireControl)))
	mux.Handle("GET /api/vehicles/{vehicle_id}/control", AuthenticationMiddleware(http.HandlerFunc(handleGetControl)))
	mux.Handle("POST /api/control/{session_id}/renew", AuthenticationMiddleware(http.HandlerFunc(handleRenewControl)))
	mux.Handle("POST /api/control/{session_id}/release", AuthenticationMiddleware(http.HandlerFunc(handleReleaseControl)))
	mux.Handle("GET /api/auth/me", AuthenticationMiddleware(http.HandlerFunc(handleAuthMe)))
	mux.Handle("POST /api/vehicles/{vehicle_id}/video/acquire", AuthenticationMiddleware(http.HandlerFunc(handleAcquireVideo)))
	mux.Handle("POST /api/video/{session_id}/release", AuthenticationMiddleware(http.HandlerFunc(handleReleaseVideo)))
	mux.Handle("GET /api/vehicles/{vehicle_id}/video", AuthenticationMiddleware(http.HandlerFunc(handleGetVideo)))

	// LiveKit webhook for lifecycle events and audit records.
	mux.HandleFunc("/api/webhook/livekit", handleLivekitWebhook)

	// Liveness and readiness probes for container orchestration.
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		if err := controlLeases.Ping(r.Context()); err != nil {
			http.Error(w, "control lease store unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Metrics and vehicle telemetry endpoints.
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/api/telemetry", AuthenticationMiddleware(http.HandlerFunc(handleTelemetry)))
	mux.Handle("POST /api/audit/events", AuthenticationMiddleware(http.HandlerFunc(handleVehicleAudit)))

	log.Println("🚀 Industrial Teleop Gateway running on :8080")
	log.Fatal(http.ListenAndServe(":8080", withCORS(mux)))
}

func withCORS(next http.Handler) http.Handler {
	allowed := make(map[string]bool)
	for _, origin := range strings.Split(os.Getenv("ALLOWED_ORIGINS"), ",") {
		origin = strings.TrimSpace(origin)
		if origin != "" {
			allowed[origin] = true
		}
	}
	if len(allowed) == 0 {
		allowed["http://localhost:8000"] = true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && !allowed[origin] {
			if r.Method == http.MethodOptions {
				http.Error(w, "origin not allowed", http.StatusForbidden)
				return
			}
		} else if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Vary", "Origin")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func AuthenticationMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			teleopAuthFailuresTotal.Inc()
			http.Error(w, "Unauthorized: Missing or invalid Bearer token", http.StatusUnauthorized)
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		claims, err := authenticator.Authenticate(r.Context(), tokenString)
		if err != nil {
			teleopAuthFailuresTotal.Inc()
			http.Error(w, "Unauthorized: invalid bearer token", http.StatusUnauthorized)
			return
		}

		// Pass authenticated claims to the handler through the request context.
		ctx := context.WithValue(r.Context(), "user", claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func handleAuthMe(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, r.Context().Value("user").(*UserClaims))
}

func recordAudit(ctx context.Context, event AuditEvent) {
	if err := auditSink.Record(ctx, event); err != nil {
		log.Printf("audit write failed: %v", err)
	}
}

// parseDevToken supports a minimal dev token format: "name|org|role1,role2"
// If token doesn't follow format, Name is set to the whole token string.
func parseDevToken(tok string) *UserClaims {
	parts := strings.Split(tok, "|")
	if len(parts) >= 3 {
		roles := []string{}
		if parts[2] != "" {
			roles = strings.Split(parts[2], ",")
		}
		return &UserClaims{Name: parts[0], Organization: parts[1], Roles: roles}
	}
	return &UserClaims{Name: tok, Roles: []string{}, Organization: "dev"}
}

// ==========================================
// 3. Operator connection and control data channel
// ==========================================
func handleOperatorConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userClaims := ctx.Value("user").(*UserClaims)

	operatorID := userClaims.Name
	vehicleID := r.URL.Query().Get("vid")
	if vehicleID == "" {
		http.Error(w, "Missing vehicle ID (vid)", http.StatusBadRequest)
		return
	}
	access, err := resolveOperatorAccess(userClaims, r.URL.Query().Get("access"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	permission := ObservePermission
	if access == ControllerAccess {
		permission = ControlPermission
	}
	if !vehicleAuthorizer.Authorize(userClaims, vehicleID, permission) {
		http.Error(w, "forbidden: vehicle ACL denied", http.StatusForbidden)
		return
	}

	lkToken, err := issueOperatorToken(vehicleID, operatorID, access)
	if err != nil {
		http.Error(w, "failed to issue LiveKit token", http.StatusInternalServerError)
		return
	}
	recordAudit(r.Context(), AuditEvent{OperatorID: operatorID, VehicleID: vehicleID, Event: "login", Result: "success"})
	recordAudit(r.Context(), AuditEvent{OperatorID: operatorID, VehicleID: vehicleID, Event: "vehicle_access", Result: "success"})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token":       lkToken,
		"operator_id": operatorID,
		"mode":        access,
		"can_control": access == ControllerAccess,
		"msg":         "Authenticated and joined the vehicle room",
	})
}

// ==========================================
// 4. Vehicle machine-to-machine connection
// ==========================================
func handleVehicleConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userClaims := ctx.Value("user").(*UserClaims)

	vehicleID, ok := vehicleIdentities.Resolve(userClaims.Name)
	// Casdoor client-credentials tokens may omit roles; a registered subject
	// with the vehicle scope is equivalent to the vehicle role.
	if !hasRole(userClaims.Roles, "vehicle") && !(ok && hasScope(userClaims.Scopes, "teleop:vehicle")) {
		http.Error(w, "Forbidden: vehicle role required", http.StatusForbidden)
		return
	}

	if !ok {
		// Legacy fallback is disabled whenever a subject map is configured.
		if vehicleIdentities.Strict() {
			http.Error(w, "forbidden: vehicle identity is not registered", http.StatusForbidden)
			return
		}
		vehicleID = userClaims.Name
	}
	if requestedVehicleID := r.URL.Query().Get("vid"); requestedVehicleID != "" && requestedVehicleID != vehicleID {
		http.Error(w, "forbidden: vehicle identity does not match vid", http.StatusForbidden)
		return
	}

	log.Printf("vehicle %s (tenant: %s) requested a media token", vehicleID, userClaims.Organization)

	lkToken, err := issueVehicleToken(vehicleID)
	if err != nil {
		http.Error(w, "failed to issue LiveKit token", http.StatusInternalServerError)
		return
	}
	recordAudit(r.Context(), AuditEvent{VehicleID: vehicleID, Event: "login", Result: "success"})
	recordAudit(r.Context(), AuditEvent{VehicleID: vehicleID, Event: "vehicle_access", Result: "success"})

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": lkToken})
}

// ==========================================
// 5. LiveKit Webhook
// ==========================================
func handleLivekitWebhook(w http.ResponseWriter, r *http.Request) {
	authProvider := auth.NewFileBasedKeyProviderFromMap(map[string]string{lkApiKey: lkApiSecret})
	event, err := webhook.ReceiveWebhookEvent(r, authProvider)
	if err != nil {
		http.Error(w, "Invalid webhook signature", http.StatusUnauthorized)
		return
	}

	if event.Event == webhook.EventParticipantLeft {
		log.Printf("participant %s left room %s", event.Participant.Identity, event.Room.Name)
		if strings.HasPrefix(event.Participant.Identity, "vehicle-") {
			recordAudit(r.Context(), AuditEvent{
				VehicleID: strings.TrimPrefix(event.Participant.Identity, "vehicle-"),
				Event:     "vehicle_disconnect",
				Result:    "success",
			})
		}
	}
	w.WriteHeader(http.StatusOK)
}

// --- Helper functions ---
func hasRole(roles []string, target string) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
}

func bp(b bool) *bool { return &b }

func controlLeaseTTL() time.Duration {
	seconds, err := strconv.Atoi(os.Getenv("CONTROL_LEASE_TTL_SECONDS"))
	if err != nil || seconds <= 0 {
		return defaultControlLeaseTTL
	}
	return time.Duration(seconds) * time.Second
}

// ==========================================
// 6. Telemetry endpoint
// ==========================================
type TelemetryPayload struct {
	VehicleID string  `json:"vehicle_id"`
	P50       float64 `json:"p50"`
	P99       float64 `json:"p99"`
	LostCount int     `json:"lost_count"`
}

func handleTelemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	if !hasRole(claims.Roles, "vehicle") {
		http.Error(w, "Forbidden: Only vehicles can post telemetry", http.StatusForbidden)
		return
	}

	var payload TelemetryPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, "Invalid json", http.StatusBadRequest)
		return
	}
	if payload.VehicleID != claims.Name {
		http.Error(w, "Forbidden: vehicle mismatch", http.StatusForbidden)
		return
	}

	// Update the Prometheus gauge.
	teleopE2eLatencyP99.WithLabelValues(payload.VehicleID).Set(payload.P99)
	log.Printf("telemetry vehicle=%s p50=%.2fms p99=%.2fms lost=%d", payload.VehicleID, payload.P50, payload.P99, payload.LostCount)

	w.WriteHeader(http.StatusOK)
}
