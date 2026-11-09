package gateway

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/daohu527/livekit-infra/backend/internal/authorization"
	"github.com/redis/go-redis/v9"
)

type enrollmentProof struct {
	RequestID  string `json:"request_id"`
	PublicKey  string `json:"public_key"`
	Name       string `json:"name"`
	Serial     string `json:"serial"`
	Platform   string `json:"platform"`
	DeviceCode string `json:"device_code"`
	Ticket     string `json:"ticket"`
	Timestamp  int64  `json:"timestamp"`
	Nonce      string `json:"nonce"`
	Signature  string `json:"signature"`
}

func (p enrollmentProof) message(action string) string {
	return strings.Join([]string{"teleop-enrollment-v1", action, p.RequestID, p.PublicKey, p.Name, p.Serial,
		p.Platform, p.DeviceCode, p.Ticket, strconv.FormatInt(p.Timestamp, 10), p.Nonce}, "\n")
}

func enrollmentText(s string, limit int) bool {
	if s == "" || len(s) > limit {
		return false
	}
	for _, c := range s {
		if c < 32 || c == 127 {
			return false
		}
	}
	return true
}

func enrollmentBytes(s string, size int) ([]byte, bool) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	return b, err == nil && len(b) == size
}

func (p enrollmentProof) verify(action string, now time.Time) ([]byte, bool) {
	key, ok := enrollmentBytes(p.PublicKey, ed25519.PublicKeySize)
	signature, valid := enrollmentBytes(p.Signature, ed25519.SignatureSize)
	if !ok || !valid || !onboardingUUID(p.RequestID) || !onboardingUUID(p.Nonce) ||
		p.Timestamp < now.Unix()-120 || p.Timestamp > now.Unix()+120 {
		return nil, false
	}
	switch action {
	case "create":
		if !enrollmentText(p.Name, 200) || (p.Serial != "" && !enrollmentText(p.Serial, 128)) || !enrollmentText(p.Platform, 128) || p.DeviceCode != "" || p.Ticket != "" {
			return nil, false
		}
	case "poll", "complete":
		_, codeOK := enrollmentBytes(p.DeviceCode, 32)
		if !codeOK || p.Name != "" || p.Serial != "" || p.Platform != "" {
			return nil, false
		}
		if action == "complete" {
			if _, ok := enrollmentBytes(p.Ticket, 32); !ok {
				return nil, false
			}
		} else if p.Ticket != "" {
			return nil, false
		}
	default:
		return nil, false
	}
	return key, ed25519.Verify(key, []byte(p.message(action)), signature)
}

type enrollmentRateLimiter struct {
	redis  redis.UniversalClient
	mu     sync.Mutex
	minute int64
	total  int
	hosts  map[string]int
}

func (l *enrollmentRateLimiter) allow(remote string, limit int) bool {
	host, _, err := net.SplitHostPort(remote)
	if err != nil {
		host = remote
	}
	minute := time.Now().Unix() / 60
	if l.redis != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		pipe := l.redis.TxPipeline()
		totalKey := fmt.Sprintf("teleop:enrollment:rate:%d:total", minute)
		hostKey := fmt.Sprintf("teleop:enrollment:rate:%d:host:%s", minute, host)
		totalCmd := pipe.Incr(ctx, totalKey)
		pipe.Expire(ctx, totalKey, 90*time.Second)
		hostCmd := pipe.Incr(ctx, hostKey)
		pipe.Expire(ctx, hostKey, 90*time.Second)
		_, redisErr := pipe.Exec(ctx)
		cancel()
		if redisErr == nil {
			return totalCmd.Val() <= 24000 && hostCmd.Val() <= int64(limit)
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hosts == nil || minute != l.minute {
		l.minute, l.total, l.hosts = minute, 0, make(map[string]int)
	}
	// Bound both unauthenticated database work and the in-memory host table.
	if l.total >= 24000 || l.hosts[host] >= limit {
		return false
	}
	l.total++
	l.hosts[host]++
	return true
}

func (s *OnboardingService) registerDeviceEnrollments(mux *http.ServeMux, authenticate func(http.Handler) http.Handler) {
	mux.Handle("GET /api/admin/organizations/{org_id}/device-enrollments/setup", authenticate(http.HandlerFunc(s.serveEnrollmentSetup)))
	for _, route := range []struct{ path, action string }{
		{"POST /api/v1/device-enrollments", "create"},
		{"POST /api/v1/device-enrollments/token", "poll"},
		{"POST /api/v1/device-enrollments/complete", "complete"},
	} {
		mux.HandleFunc(route.path, func(w http.ResponseWriter, r *http.Request) { s.serveDeviceEnrollment(w, r, route.action) })
	}
	for _, route := range []string{
		"POST /api/admin/organizations/{org_id}/device-enrollments/lookup",
		"POST /api/admin/organizations/{org_id}/device-enrollments/{enrollment_id}/approve",
		"POST /api/admin/organizations/{org_id}/device-enrollments/{enrollment_id}/deny",
	} {
		mux.Handle(route, authenticate(http.HandlerFunc(s.serveEnrollmentApproval)))
	}
}

func enrollmentError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, authorization.ErrEnrollmentReplay):
		writeDiagnosticError(w, r, "request already used; retry with a fresh nonce", "ENROLLMENT_REPLAY", http.StatusConflict)
	case errors.Is(err, authorization.ErrEnrollmentSlow):
		w.Header().Set("Retry-After", "5")
		writeDiagnosticError(w, r, "wait before polling again", "ENROLLMENT_SLOW_DOWN", http.StatusTooManyRequests)
	case errors.Is(err, authorization.ErrEnrollmentTicketExpired):
		writeDiagnosticError(w, r, "installation ticket expired; poll the same enrollment for a new ticket", "ENROLLMENT_TICKET_EXPIRED", http.StatusGone)
	case errors.Is(err, authorization.ErrEnrollmentInvalid), errors.Is(err, authorization.ErrInstallationTicket):
		writeDiagnosticError(w, r, "enrollment or ticket is unavailable; refresh enrollment status", "ENROLLMENT_INVALID", http.StatusNotFound)
	case errors.Is(err, errManagedDrain), errors.Is(err, errManagedMaintenance):
		writeDiagnosticError(w, r, "credential recovery requires safely drained maintenance", "MANAGED_DRAIN_REQUIRED", http.StatusConflict)
	default:
		onboardingHTTPError(w, r, err)
	}
}

func (s *OnboardingService) serveDeviceEnrollment(w http.ResponseWriter, r *http.Request, action string) {
	w.Header().Set("Cache-Control", "no-store")
	// The Gateway may sit behind one trusted reverse proxy; do not apply a
	// tiny IP polling budget that throttles an entire customer's fleet.
	if !s.enrollmentRate.allow(r.RemoteAddr, 2400) {
		w.Header().Set("Retry-After", "30")
		writeDiagnosticError(w, r, "registration service is busy; retry shortly", "ENROLLMENT_SLOW_DOWN", http.StatusTooManyRequests)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	var proof enrollmentProof
	if err := decodeManagedBody(w, r, &proof, "request_id", "public_key", "name", "serial", "platform", "device_code", "ticket", "timestamp", "nonce", "signature"); err != nil {
		writeDiagnosticError(w, r, "invalid signed enrollment request", "ENROLLMENT_PROOF_INVALID", http.StatusBadRequest)
		return
	}
	key, valid := proof.verify(action, time.Now())
	if !valid {
		writeDiagnosticError(w, r, "device proof is invalid; check key and clock", "ENROLLMENT_PROOF_INVALID", http.StatusUnauthorized)
		return
	}
	limit := 30
	if action == "create" {
		limit = 6
	}
	if !s.enrollmentRate.allow("device-"+action+"-"+proof.PublicKey, limit) {
		enrollmentError(w, r, authorization.ErrEnrollmentSlow)
		return
	}
	if err := s.mutate(ctx, "", func() error { return s.store.UseEnrollmentNonce(ctx, key, proof.Nonce) }); err != nil {
		enrollmentError(w, r, err)
		return
	}
	if action == "create" {
		s.createDeviceEnrollment(w, r, proof, key)
		return
	}
	hash := sha256.Sum256([]byte(proof.DeviceCode))
	var e authorization.DeviceEnrollment
	err := s.mutate(ctx, "", func() error {
		var err error
		e, err = s.store.DeviceEnrollment(ctx, proof.RequestID, key, hash[:], action == "poll")
		return err
	})
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	if action == "complete" {
		s.completeDeviceEnrollment(w, r, e, proof.Ticket)
		return
	}
	s.pollDeviceEnrollment(w, r, e)
}

func (s *OnboardingService) createDeviceEnrollment(w http.ResponseWriter, r *http.Request, proof enrollmentProof, key []byte) {
	code, err := onboardingRandom()
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	ciphertext, err := s.encryptCredential(code)
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	// 40 bits of user-code entropy plus per-host/global attempt limits.
	const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		enrollmentError(w, r, err)
		return
	}
	for i := range random {
		random[i] = alphabet[int(random[i])%len(alphabet)]
	}
	hash := sha256.Sum256([]byte(code))
	in := authorization.DeviceEnrollment{ID: proof.RequestID, Name: proof.Name, Serial: proof.Serial, Platform: proof.Platform,
		PublicKey: key, UserCode: string(random), DeviceCodeHash: hash[:], DeviceCodeCiphertext: ciphertext}
	var e authorization.DeviceEnrollment
	err = s.mutate(r.Context(), "", func() error {
		var err error
		e, err = s.store.CreateDeviceEnrollment(r.Context(), in)
		return err
	})
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	if e.Status == "active" {
		writeJSON(w, http.StatusOK, map[string]any{"id": e.ID, "status": "active", "interval": 5, "expires_at": e.ExpiresAt, "expires_in": 0})
		return
	}
	code, err = s.decryptCredential(e.DeviceCodeCiphertext)
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": e.ID, "status": e.Status, "device_code": code,
		"user_code": e.UserCode[:4] + "-" + e.UserCode[4:], "interval": 5, "expires_at": e.ExpiresAt,
		"expires_in": max(0, int(time.Until(e.ExpiresAt).Seconds()))})
}

func (s *OnboardingService) pollDeviceEnrollment(w http.ResponseWriter, r *http.Request, e authorization.DeviceEnrollment) {
	result := map[string]any{"id": e.ID, "status": e.Status, "interval": 5, "expires_at": e.ExpiresAt, "error_code": ""}
	if e.Status != "approved" {
		writeJSON(w, http.StatusOK, result)
		return
	}
	op, err := s.store.GetOnboarding(r.Context(), e.ActorUserID, e.OrganizationID, e.OperationID)
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	switch op.Status {
	case "pending", "running":
		result["status"] = "provisioning"
	case "failed":
		result["status"], result["error_code"] = "failed", op.ErrorCode
	case "completed":
		result["status"] = "active"
	case "awaiting_install":
		if op.ErrorCode != "" {
			result["status"], result["error_code"] = "failed", op.ErrorCode
			break
		}
		result["status"] = "awaiting_install"
		if !e.TicketExpiresAt.After(time.Now().Add(10 * time.Second)) {
			ticket, err := onboardingRandom()
			if err != nil {
				enrollmentError(w, r, err)
				return
			}
			ciphertext, err := s.encryptCredential(ticket)
			if err != nil {
				enrollmentError(w, r, err)
				return
			}
			hash := sha256.Sum256([]byte(ticket))
			e.TicketExpiresAt = time.Now().UTC().Add(5 * time.Minute)
			err = s.mutate(r.Context(), e.OrganizationID, func() error {
				return s.store.IssueDeviceEnrollmentTicket(r.Context(), e, hash[:], ciphertext, e.TicketExpiresAt)
			})
			if err != nil {
				enrollmentError(w, r, err)
				return
			}
			e.TicketCiphertext = ciphertext
		}
		ticket, err := s.decryptCredential(e.TicketCiphertext)
		if err != nil {
			enrollmentError(w, r, err)
			return
		}
		result["ticket"], result["ticket_expires_at"] = ticket, e.TicketExpiresAt
	default:
		enrollmentError(w, r, authorization.ErrEnrollmentInvalid)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *OnboardingService) completeDeviceEnrollment(w http.ResponseWriter, r *http.Request, e authorization.DeviceEnrollment, ticket string) {
	hash := sha256.Sum256([]byte(ticket))
	var op authorization.OnboardingOperation
	err := s.mutate(r.Context(), e.OrganizationID, func() error {
		var err error
		op, err = s.store.RedeemDeviceEnrollment(r.Context(), e, hash[:])
		return err
	})
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	secret, err := s.decryptCredential(op.CredentialCiphertext)
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	s.writeVehicleCredentials(w, op, secret)
}

func enrollmentView(e authorization.DeviceEnrollment) map[string]any {
	hash := sha256.Sum256(e.PublicKey)
	return map[string]any{"id": e.ID, "name": e.Name, "serial": e.Serial, "platform": e.Platform,
		"status": e.Status, "fingerprint": "SHA256:" + hex.EncodeToString(hash[:]), "recovery": e.Recovery,
		"created_at": e.CreatedAt, "expires_at": e.ExpiresAt, "vehicle_id": e.VehicleID, "operation_id": e.OperationID}
}

func normalizeUserCode(raw string) (string, bool) {
	code := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(raw), "-", ""))
	if len(code) != 8 {
		return "", false
	}
	for _, c := range code {
		if !strings.ContainsRune("23456789ABCDEFGHJKLMNPQRSTUVWXYZ", c) {
			return "", false
		}
	}
	return code, true
}

func (s *OnboardingService) serveEnrollmentApproval(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	org := r.PathValue("org_id")
	if claims == nil || claims.UserID == "" || claims.Issuer != s.issuer || !onboardingUUID(org) {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	if !s.enrollmentRate.allow("admin-"+claims.UserID, 60) {
		enrollmentError(w, r, authorization.ErrEnrollmentSlow)
		return
	}
	if strings.HasSuffix(r.Pattern, "/lookup") {
		var body struct {
			UserCode string `json:"user_code"`
		}
		if err := decodeManagedBody(w, r, &body, "user_code"); err != nil {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		code, ok := normalizeUserCode(body.UserCode)
		if !ok {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		e, err := s.store.LookupDeviceEnrollment(r.Context(), claims.UserID, org, code)
		if err != nil {
			enrollmentError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, enrollmentView(e))
		return
	}
	id := r.PathValue("enrollment_id")
	if !onboardingUUID(id) {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	var body struct {
		Name          string `json:"name"`
		VehicleNumber string `json:"vehicle_number"`
	}
	if err := decodeManagedBody(w, r, &body, "name", "vehicle_number"); err != nil {
		managedAdminError(w, r, authorization.ErrInvalidRegistration)
		return
	}
	var e authorization.DeviceEnrollment
	var err error
	if strings.HasSuffix(r.Pattern, "/deny") {
		if body.Name != "" || body.VehicleNumber != "" {
			managedAdminError(w, r, authorization.ErrInvalidRegistration)
			return
		}
		err = s.mutate(r.Context(), org, func() error {
			var err error
			e, err = s.store.DenyDeviceEnrollment(r.Context(), claims.UserID, org, id)
			return err
		})
	} else {
		// Never wait for a provider operation with an unbounded administrator request.
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		e, err = s.approveEnrollment(r.Context(), claims.UserID, org, id, body.Name, body.VehicleNumber)
	}
	if err != nil {
		enrollmentError(w, r, err)
		return
	}
	status := http.StatusOK
	if e.Status == "approved" {
		status = http.StatusAccepted
	}
	writeJSON(w, status, enrollmentView(e))
}

func (s *OnboardingService) approveEnrollment(ctx context.Context, actor, org, id, name, number string) (authorization.DeviceEnrollment, error) {
	e, err := s.store.EnrollmentForApproval(ctx, actor, org, id)
	if err != nil {
		return e, err
	}
	if e.Status == "approved" {
		return e, nil
	}
	if !e.Recovery {
		if number == "" {
			number = "vehicle-" + strings.ReplaceAll(id, "-", "")[:12]
		}
		secret, err := onboardingRandom()
		if err != nil {
			return e, err
		}
		ciphertext, err := s.encryptCredential(secret)
		if err != nil {
			return e, err
		}
		err = s.mutate(ctx, org, func() error {
			var err error
			e, err = s.store.CreateApprovedDeviceEnrollment(ctx, actor, org, id, authorization.OnboardingRequest{
				Kind: "vehicle", Name: name, VehicleNumber: number, IdempotencyKey: id}, ciphertext)
			return err
		})
		return e, err
	}
	if name != "" || number != "" {
		return e, authorization.ErrInvalidRegistration
	}
	if !s.workMu.TryLock() {
		return e, authorization.ErrEnrollmentSlow
	}
	defer s.workMu.Unlock()
	op, err := s.store.GetOnboarding(ctx, actor, org, e.OperationID)
	if err != nil {
		return e, err
	}
	if op.Status == "completed" || op.Status == "awaiting_install" {
		if s.acquireMutation == nil {
			return e, errManagedDrain
		}
		release, err := s.acquireMutation(ctx, org)
		if err != nil {
			return e, err
		}
		if release == nil {
			return e, fmt.Errorf("credential recovery guard unavailable")
		}
		defer release()
		secret, err := onboardingRandom()
		if err != nil {
			return e, err
		}
		ciphertext, err := s.encryptCredential(secret)
		if err != nil {
			return e, err
		}
		op, err = s.store.PrepareDeviceEnrollmentRecovery(ctx, actor, org, op.ID, ciphertext)
		if err == nil {
			err = s.rotateVehicle(ctx, op, secret)
		}
		if err == nil {
			err = s.verifyVehicleToken(ctx, op)
		}
		if err == nil {
			err = s.store.ClearDeviceEnrollmentRecoveryError(ctx, actor, org, op.ID)
		}
		if err != nil {
			return e, err
		}
		// Already inside the exclusive mutation guard.
		return s.store.ApproveDeviceEnrollment(ctx, actor, org, id, op.ID)
	}
	if op.Status == "failed" {
		err = s.mutate(ctx, org, func() error {
			var err error
			op, err = s.store.RetryOnboarding(ctx, actor, org, op.ID)
			return err
		})
		if err != nil {
			return e, err
		}
	}
	err = s.mutate(ctx, org, func() error {
		var err error
		e, err = s.store.ApproveDeviceEnrollment(ctx, actor, org, id, op.ID)
		return err
	})
	return e, err
}

func (s *OnboardingService) serveEnrollmentSetup(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	claims, _ := r.Context().Value("user").(*UserClaims)
	org := r.PathValue("org_id")
	if claims == nil || claims.UserID == "" || claims.Issuer != s.issuer || !onboardingUUID(org) {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	allowed, err := s.store.CanManageOrganization(r.Context(), claims.UserID, org)
	if err != nil {
		managedAdminError(w, r, err)
		return
	}
	if !allowed {
		managedAdminError(w, r, authorization.ErrNotOrganizationAdmin)
		return
	}
	console := s.config.ConsoleURL
	if console == "" {
		console = s.config.GatewayURL
	}
	writeJSON(w, http.StatusOK, map[string]string{"gateway_url": s.config.GatewayURL, "console_url": console, "platform": "apollo"})
}
