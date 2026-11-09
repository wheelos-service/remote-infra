package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type vehicleBootstrapClient struct {
	t      *testing.T
	dir    string
	binary string
}

type vehicleBootstrapProcess struct {
	done   chan struct{}
	cancel context.CancelFunc
	err    error
	output bytes.Buffer
	child  *os.Process
}

func newVehicleBootstrapClient(t *testing.T, gatewayURL, serial string) *vehicleBootstrapClient {
	t.Helper()
	binary := os.Getenv("VEHICLE_BOOTSTRAP_TEST_BINARY")
	if binary == "" {
		t.Skip("set VEHICLE_BOOTSTRAP_TEST_BINARY to run the actual C++ bootstrap")
	}
	if os.Geteuid() != 0 {
		t.Skip("vehicle bootstrap requires root-owned storage in an isolated root test container")
	}
	c := &vehicleBootstrapClient{t: t, dir: t.TempDir(), binary: binary}
	if err := os.Chmod(c.dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(c.dir, "state"), 0700); err != nil {
		t.Fatal(err)
	}
	c.write("bootstrap.json", map[string]any{"gateway_url": gatewayURL, "console_url": gatewayURL,
		"name": "C++ bootstrap test", "serial": serial, "platform": "test",
		"state_directory": "state", "device_template": "template.json", "device_config": "device.json",
		"allow_insecure_localhost": true, "allow_legacy_complete_404": false})
	c.write("template.json", map[string]any{"control_mode": "cyber", "media_enabled": false})
	return c
}

func (c *vehicleBootstrapClient) write(name string, value any) {
	c.t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		c.t.Fatal("could not encode protected test configuration")
	}
	if err := os.WriteFile(filepath.Join(c.dir, name), raw, 0600); err != nil {
		c.t.Fatal(err)
	}
}

func (c *vehicleBootstrapClient) read(name string) map[string]any {
	c.t.Helper()
	raw, err := os.ReadFile(filepath.Join(c.dir, name))
	if err != nil {
		c.t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		c.t.Fatal("could not decode protected test configuration")
	}
	return value
}

func (c *vehicleBootstrapClient) start(timeout time.Duration) *vehicleBootstrapProcess {
	c.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	p := &vehicleBootstrapProcess{done: make(chan struct{}), cancel: cancel}
	args := []string{"--config", "bootstrap.json"}
	program := c.binary
	if loader := os.Getenv("VEHICLE_BOOTSTRAP_TEST_LOADER"); loader != "" {
		program = loader
		args = append([]string{"--library-path", os.Getenv("VEHICLE_BOOTSTRAP_TEST_LIBRARY_PATH"), c.binary}, args...)
	}
	command := exec.CommandContext(ctx, program, args...)
	command.Dir = c.dir
	command.Stdout, command.Stderr = &p.output, &p.output
	if err := command.Start(); err != nil {
		cancel()
		c.t.Fatal(err)
	}
	p.child = command.Process
	go func() {
		p.err = command.Wait()
		close(p.done)
	}()
	c.t.Cleanup(p.stop)
	return p
}

func (p *vehicleBootstrapProcess) stop() {
	p.cancel()
	<-p.done
}

func (p *vehicleBootstrapProcess) wait() error {
	<-p.done
	return p.err
}

func waitForBootstrap(t *testing.T, timeout time.Duration, stage string, ready func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if ready() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("vehicle bootstrap did not reach %s within %s", stage, timeout)
}

type vehicleBootstrapResponseLoss struct {
	complete atomic.Bool
	ack      atomic.Bool
	ackLost  chan struct{}
}

func (loss *vehicleBootstrapResponseLoss) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var flag *atomic.Bool
		if r.URL.Path == "/api/v1/device-enrollments/complete" {
			flag = &loss.complete
		} else if strings.HasSuffix(r.URL.Path, "/installation-complete") {
			flag = &loss.ack
		}
		if flag == nil || !flag.Load() {
			next.ServeHTTP(w, r)
			return
		}
		recorder := httptest.NewRecorder()
		next.ServeHTTP(recorder, r)
		if recorder.Code >= 200 && recorder.Code < 300 && flag.CompareAndSwap(true, false) {
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				http.Error(w, "test connection could not be interrupted", 500)
				return
			}
			connection.Close()
			if flag == &loss.ack {
				close(loss.ackLost)
			}
			return
		}
		for key, values := range recorder.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(recorder.Code)
		_, _ = io.Copy(w, recorder.Body)
	})
}

// This wire test runs the real C++ client and PostgreSQL enrollment state.
// Actual provider JWT/JWKS behavior is covered by the Casdoor contract runner.
func TestPostgresVehicleBootstrapClient(t *testing.T) {
	if os.Getenv("VEHICLE_BOOTSTRAP_TEST_BINARY") == "" {
		t.Skip("set VEHICLE_BOOTSTRAP_TEST_BINARY to run the actual C++ bootstrap")
	}
	f := newManagedFixture(t)
	s := onboardingTestService(t)
	s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
	s.Register(f.mux, AuthenticationMiddleware)
	var mu sync.Mutex
	var clientID, secret, subject string
	var reject, unavailable atomic.Bool
	authenticator = diagnosticAuthenticator(func(_ context.Context, token string) (*UserClaims, error) {
		mu.Lock()
		defer mu.Unlock()
		if subject == "" || token != subject {
			return nil, ErrInvalidToken
		}
		return &UserClaims{Name: subject, Issuer: managedTestIssuer,
			TokenType: "access-token", Audiences: []string{clientID},
			Scopes: []string{"teleop:vehicle"}}, nil
	})
	f.mux.HandleFunc("POST /api/login/oauth/access_token", func(w http.ResponseWriter, r *http.Request) {
		if unavailable.Load() {
			writeJSON(w, 503, map[string]string{"error": "invalid_client"})
			return
		}
		if err := r.ParseForm(); err != nil {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if reject.Load() || r.Form.Get("client_id") != clientID || r.Form.Get("client_secret") != secret {
			writeJSON(w, 400, map[string]string{"error": "invalid_client"})
			return
		}
		writeJSON(w, 200, map[string]any{"access_token": subject, "expires_in": 360})
	})
	server := httptest.NewServer(withRequestID(f.mux))
	defer server.Close()
	s.config.GatewayURL, s.config.CasdoorURL = server.URL, server.URL
	client := newVehicleBootstrapClient(t, server.URL, "cpp-bootstrap-test")
	first := client.start(30 * time.Second)
	var id, userCode string
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		err := f.db.QueryRow(`SELECT enrollment_id,user_code FROM authz_device_enrollments WHERE serial='cpp-bootstrap-test'`).Scan(&id, &userCode)
		if err == nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if id == "" {
		t.Fatalf("C++ client failed before registration: %v", first.wait())
	}
	e, err := s.approveEnrollment(context.Background(), f.adminID, f.orgID, id, "C++ test vehicle", "cpp-001")
	if err != nil {
		t.Fatal(err)
	}
	op, err := f.store.GetOnboarding(context.Background(), f.adminID, f.orgID, e.OperationID)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	clientID, secret, subject = op.ClientID, "", "admin/"+op.ProviderName
	secret, err = s.decryptCredential(op.CredentialCiphertext)
	mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.StartOnboarding(context.Background(), op.ID); err != nil {
		t.Fatal(err)
	}
	if err := f.store.BindOnboarding(context.Background(), op, managedTestIssuer, subject); err != nil {
		t.Fatal(err)
	}
	result := first.wait()
	var status string
	if err := f.db.QueryRow(`SELECT status FROM authz_device_enrollments WHERE enrollment_id=$1`, id).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "active" || result != nil {
		t.Fatalf("C++ client did not acknowledge installation: exit=%v, enrollment=%s", result, status)
	}
	config := client.read("device.json")
	if config["vehicle_id"] != op.VehicleID || config["client_id"] != clientID || config["control_mode"] != "disabled" {
		t.Fatal("C++ client saved inconsistent vehicle identity or enabled control")
	}
	info, err := os.Stat(filepath.Join(client.dir, "device.json"))
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("device credential file was not protected")
	}
	config["vehicle_id"] = "car-two"
	client.write("device.json", config)
	var blocked *exec.ExitError
	blockedProc := client.start(10 * time.Second)
	if err := blockedProc.wait(); !errors.As(err, &blocked) || blocked.ExitCode() != 78 {
		t.Fatal("wrong Gateway mapping did not block without automatic reenrollment")
	}
	if !strings.Contains(blockedProc.output.String(), "stage=device_auth_check") ||
		!strings.Contains(blockedProc.output.String(), "http=403") ||
		strings.Contains(blockedProc.output.String(), secret) {
		t.Fatalf("blocked C++ client did not emit sanitized stage/http diagnostic: %s", blockedProc.output.String())
	}
	if state := client.read("state/enrollment.json"); state["stage"] != "device_auth_check" || state["last_http_status"] != float64(403) {
		t.Fatalf("blocked C++ client did not persist stage/http diagnostic in enrollment.json: %v", state)
	}
	config["vehicle_id"] = op.VehicleID
	client.write("device.json", config)
	unavailable.Store(true)
	client.start(7 * time.Second).wait()
	if state := client.read("state/enrollment.json"); state["request_id"] != id || state["status"] != "installed" ||
		state["stage"] != "oauth_token" || state["last_http_status"] != float64(503) {
		t.Fatal("transient OAuth failure changed the enrollment or installed state or omitted retry diagnostic")
	}
	unavailable.Store(false)
	reject.Store(true)
	recovery := client.start(20 * time.Second)
	var recoveryID string
	waitForBootstrap(t, 18*time.Second, "same-identity recovery", func() bool {
		return f.db.QueryRow(`SELECT enrollment_id FROM authz_device_enrollments WHERE status='pending' AND recovery AND operation_id=$1`, op.ID).Scan(&recoveryID) == nil
	})
	recovery.stop()
	client.start(6 * time.Second).wait()
	var recoveryAfterRestart string
	if err := f.db.QueryRow(`SELECT enrollment_id FROM authz_device_enrollments WHERE status='pending' AND recovery AND operation_id=$1`, op.ID).Scan(&recoveryAfterRestart); err != nil || recoveryAfterRestart != recoveryID {
		t.Fatal("retry while awaiting recovery approval refreshed the device code again")
	}
	var operations int
	if err := f.db.QueryRow(`SELECT count(*) FROM authz_onboarding_operations WHERE vehicle_id=$1`, op.VehicleID).Scan(&operations); err != nil || operations != 1 {
		t.Fatal("client-authentication failure duplicated the registered vehicle")
	}
	var enrollments int
	if err := f.db.QueryRow(`SELECT count(*) FROM authz_device_enrollments WHERE serial='cpp-bootstrap-test'`).Scan(&enrollments); err != nil || enrollments != 2 {
		t.Fatal("mapping or transient errors created additional enrollment codes")
	}
}

func TestPostgresVehicleBootstrapDenialAndExpiry(t *testing.T) {
	for _, decision := range []string{"denied", "expired", "cancelled"} {
		t.Run(decision, func(t *testing.T) {
			if os.Getenv("VEHICLE_BOOTSTRAP_TEST_BINARY") == "" {
				t.Skip("set VEHICLE_BOOTSTRAP_TEST_BINARY to run the actual C++ bootstrap")
			}
			f := newManagedFixture(t)
			s := onboardingTestService(t)
			s.store, s.issuer, s.acquireAdditive = f.store, managedTestIssuer, f.runtime.BeforeAdditive
			s.Register(f.mux, AuthenticationMiddleware)
			server := httptest.NewServer(withRequestID(f.mux))
			defer server.Close()
			client := newVehicleBootstrapClient(t, server.URL, decision)
			process := client.start(30 * time.Second)
			var id, userCode string
			var key []byte
			waitForBootstrap(t, 10*time.Second, "pending approval", func() bool {
				return f.db.QueryRow(`SELECT enrollment_id,user_code,public_key FROM authz_device_enrollments WHERE serial=$1`, decision).Scan(&id, &userCode, &key) == nil
			})
			adminPath := "/api/admin/organizations/" + f.orgID + "/device-enrollments"
			if decision == "cancelled" {
				if err := process.child.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
				if err := process.wait(); err != nil {
					t.Fatal("graceful cancellation did not exit cleanly")
				}
				if client.read("state/enrollment.json")["status"] == "installed" ||
					strings.Contains(process.output.String(), "installation acknowledged") {
					t.Fatal("graceful cancellation incorrectly reported successful registration")
				}
			} else if decision == "denied" {
				f.request(t, "POST", adminPath+"/"+id+"/deny", "admin", "", "{}", 200)
				var denied *exec.ExitError
				if err := process.wait(); !errors.As(err, &denied) || denied.ExitCode() != 77 ||
					!strings.Contains(process.output.String(), "code=ENROLLMENT_DENIED") {
					t.Fatal("denial did not stop the actual vehicle client with exit 77 and ENROLLMENT_DENIED diagnostic")
				}
				if err := client.start(5 * time.Second).wait(); !errors.As(err, &denied) || denied.ExitCode() != 77 {
					t.Fatal("restart did not preserve denied status")
				}
			} else {
				if _, err := f.db.Exec(`UPDATE authz_device_enrollments SET expires_at=now()-interval '1 second' WHERE enrollment_id=$1`, id); err != nil {
					t.Fatal(err)
				}
				response := f.request(t, "POST", adminPath+"/lookup", "admin", "", `{"user_code":"`+userCode+`"}`, 200)
				var expired map[string]any
				if json.Unmarshal(response.Body.Bytes(), &expired) != nil || expired["status"] != "expired" {
					t.Fatal("administrator lookup did not explicitly report expiry")
				}
				var freshID string
				var freshKey []byte
				waitForBootstrap(t, 18*time.Second, "fresh code after simulated server expiry", func() bool {
					return f.db.QueryRow(`SELECT enrollment_id,public_key FROM authz_device_enrollments WHERE serial=$1 AND enrollment_id<>$2`, decision, id).Scan(&freshID, &freshKey) == nil
				})
				if !bytes.Equal(key, freshKey) {
					t.Fatal("code expiry replaced the persistent device key")
				}
				process.stop()
				client.start(6 * time.Second).wait()
				if client.read("state/enrollment.json")["request_id"] != freshID {
					t.Fatal("restart after expiry refreshed the new pending code again")
				}
			}
			var total int
			want := 1
			if decision == "expired" {
				want = 2
			}
			if err := f.db.QueryRow(`SELECT count(*) FROM authz_device_enrollments WHERE serial=$1`, decision).Scan(&total); err != nil || total != want {
				t.Fatal("decision/restart created unexpected enrollment requests")
			}
		})
	}
}
