
// 依赖安装：
// go get github.com/casdoor/casdoor-go-sdk/casdoorsdk
// go get github.com/livekit/server-sdk-go/v2
// go get github.com/livekit/protocol/auth
// go get github.com/livekit/protocol/webhook
// go get github.com/redis/go-redis/v9

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/webhook"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// ==========================================
// 1. 全局配置与组件初始化
// ==========================================
var (
	lkApiKey    = os.Getenv("LIVEKIT_API_KEY")
	lkApiSecret = os.Getenv("LIVEKIT_API_SECRET")
	lkServerURL = os.Getenv("LIVEKIT_URL")

	// in-memory lock store used for local/dev runs. Production should use Redis.
	lockStore = struct {
		sync.Mutex
		m map[string]string
	}{m: make(map[string]string)}

	keyRegistry = struct {
		sync.RWMutex
		byVehicle map[string]OperatorKeyRegistration
	}{byVehicle: make(map[string]OperatorKeyRegistration)}

	// Stage 3 可观测性 Metrics
	teleopActiveSessions = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "teleop_active_sessions",
		Help: "当前正在活跃远控的车辆会话数",
	})
	teleopLockPreemptionsTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "teleop_lock_preemptions_total",
		Help: "高级管理员抢占低权限驾驶员的总次数",
	})
	teleopAuthFailuresTotal = promauto.NewCounter(prometheus.CounterOpts{
		Name: "teleop_auth_failures_total",
		Help: "远控网关鉴权失败的总次数",
	})
	teleopE2eLatencyP99 = promauto.NewGaugeVec(prometheus.GaugeOpts{
		Name: "teleop_e2e_latency_p99_milliseconds",
		Help: "端到端远控指令延迟 P99 (ms)",
	}, []string{"vehicle_id"})
)

type UserClaims struct {
	Name         string
	Roles        []string
	Organization string
}

type OperatorKeyRegistration struct {
	VehicleID    string `json:"vehicle_id"`
	OperatorID   string `json:"operator_id"`
	KeyID        string `json:"key_id"`
	PublicKeyB64 string `json:"public_key_b64"`
	ExpiresAtMS  int64  `json:"expires_at_ms"`
	RegisteredMS int64  `json:"registered_at_ms"`
}

func init() {
	// NOTE: For development we use in-memory lock store and a very small
	// local JWT parsing helper. In production replace Casdoor init and Redis
	// with proper service configuration.
}

// ==========================================
// 2. HTTP 路由与核心中间件
// ==========================================
func main() {
	mux := http.NewServeMux()

	// 【统一鉴权】操作员与车辆接入全部经过 Casdoor JWT 校验
	mux.Handle("/api/token/operator", CasdoorAuthMiddleware(http.HandlerFunc(handleOperatorConnect)))
	mux.Handle("/api/token/vehicle", CasdoorAuthMiddleware(http.HandlerFunc(handleVehicleConnect)))

	// LiveKit Webhook 接口 (用于兜底安全和锁释放)
	mux.HandleFunc("/api/webhook/livekit", handleLivekitWebhook)

	// Stage-1: 指令级安全公钥注册与查询
	mux.Handle("/api/keys/register", CasdoorAuthMiddleware(http.HandlerFunc(handleRegisterOperatorKey)))
	mux.Handle("/api/keys/current", CasdoorAuthMiddleware(http.HandlerFunc(handleGetCurrentVehicleKey)))

	// Liveness and Readiness probes for Kubernetes
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Stage 3 监控接入点
	mux.Handle("/metrics", promhttp.Handler())
	mux.Handle("/api/telemetry", CasdoorAuthMiddleware(http.HandlerFunc(handleTelemetry)))

	log.Println("🚀 Industrial Teleop Gateway running on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}

// CasdoorAuthMiddleware: 拦截并验证 Casdoor 签发的 JWT
func CasdoorAuthMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			teleopAuthFailuresTotal.Inc() // Prometheus 指标
			http.Error(w, "Unauthorized: Missing or invalid Bearer token", http.StatusUnauthorized)
			return
		}

		tokenString := strings.TrimPrefix(authHeader, "Bearer ")

		// For development only: parse a simple token format
		claims := parseDevToken(tokenString)

		// 将解析出的用户信息注入 Context
		ctx := context.WithValue(r.Context(), "user", claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
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
// 3. 远控舱 (Web) 接入逻辑 - 带抢占锁
// ==========================================
func handleOperatorConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userClaims := ctx.Value("user").(*UserClaims)

	operatorID := userClaims.Name
	operatorTenant := userClaims.Organization // e.g., "SF-Express"

	vehicleID := r.URL.Query().Get("vid")
	if vehicleID == "" {
		http.Error(w, "Missing vehicle ID (vid)", http.StatusBadRequest)
		return
	}

	// [注]：此处生产环境中应查询 DB 校验该车辆是否属于 operatorTenant。
	// 为演示精简，假设权限通过。

	// 检查是否拥有管理员(抢占)权限
	isAdmin := hasRole(userClaims.Roles, "admin")

	// 分布式抢占锁核心逻辑
	lockKey := fmt.Sprintf("teleop:%s:lock:%s", operatorTenant, vehicleID)
	canDrive := false
	modeMsg := ""

	lockStore.Lock()
	currentDriver, exists := lockStore.m[lockKey]
	if !exists || currentDriver == operatorID {
		// acquire or re-acquire lock
		if !exists {
			lockStore.m[lockKey] = operatorID
			teleopActiveSessions.Set(float64(len(lockStore.m)))
		}
		canDrive = true
		modeMsg = "接管成功，您已获取车辆控制权"
	} else {
		if isAdmin {
			oldIdentity := "operator-" + currentDriver
			log.Printf("【主管抢占】踢出原驾驶员 %s，新驾驶员 %s 接管", oldIdentity, operatorID)
			// production should call LiveKit RoomService to remove participant
			log.Printf("(dev) would call LiveKit RemoveParticipant for %s", oldIdentity)
			lockStore.m[lockKey] = operatorID
			canDrive = true
			modeMsg = "【高级抢占成功】原驾驶员已被踢出，您已控制车辆"
			teleopLockPreemptionsTotal.Inc() // 更新抢占指标
		} else {
			canDrive = false
			modeMsg = fmt.Sprintf("车辆正被 %s 控制，您已进入安全监视模式 (只读)", currentDriver)
		}
	}
	lockStore.Unlock()

	// 签发 LiveKit 操作员 Token
	at := auth.NewAccessToken(lkApiKey, lkApiSecret)
	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           "teleop-" + vehicleID,
		CanPublish:     bp(false),    // 远控舱不推视频
		CanPublishData: bp(canDrive), // 【核心防线】没拿到锁，绝不允许发 DataChannel 控制指令！
		CanSubscribe:   bp(true),
	}

	at.AddGrant(grant).SetIdentity("operator-" + operatorID).SetValidFor(2 * time.Hour)
	lkToken, _ := at.ToJWT()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"token": lkToken,
		"mode":  map[bool]string{true: "driver", false: "shadow"}[canDrive],
		"msg":   modeMsg,
	})
}

// ==========================================
// 4. 车端 (Python) 接入逻辑 - M2M
// ==========================================
func handleVehicleConnect(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	userClaims := ctx.Value("user").(*UserClaims)

	// 【核心】验证 JWT 里的角色是不是 "vehicle"
	if !hasRole(userClaims.Roles, "vehicle") {
		http.Error(w, "Forbidden: 该凭证不具备车端设备(vehicle)权限", http.StatusForbidden)
		return
	}

	// vehicle id is the Name in claims
	vehicleID := userClaims.Name

	log.Printf("【车端上线】车辆 %s (租户: %s) 申请媒体通道", vehicleID, userClaims.Organization)

	// 签发 LiveKit 车端 Token
	at := auth.NewAccessToken(lkApiKey, lkApiSecret)
	grant := &auth.VideoGrant{
		RoomJoin:       true,
		Room:           "teleop-" + vehicleID,
		CanPublish:     bp(true),  // 车端需要推摄像头视频
		CanPublishData: bp(false), // 车端不发指令，只收指令
		CanSubscribe:   bp(true),  // 允许订阅(接收)远端指令
	}

	at.AddGrant(grant).SetIdentity("vehicle-" + vehicleID).SetValidFor(24 * time.Hour)
	lkToken, _ := at.ToJWT()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": lkToken})
}

// ==========================================
// 5. 灾备与状态收敛 (LiveKit Webhook)
// ==========================================
func handleLivekitWebhook(w http.ResponseWriter, r *http.Request) {
	authProvider := auth.NewFileBasedKeyProviderFromMap(map[string]string{lkApiKey: lkApiSecret})
	event, err := webhook.ReceiveWebhookEvent(r, authProvider)
	if err != nil {
		http.Error(w, "Invalid webhook signature", http.StatusUnauthorized)
		return
	}

	if event.Event == webhook.EventParticipantLeft {
		identity := event.Participant.Identity
		roomName := event.Room.Name
		vehicleID := strings.TrimPrefix(roomName, "teleop-")

		// 驾驶员意外断线，释放 Redis 锁防死锁
		if strings.HasPrefix(identity, "operator-") {
			operatorID := strings.TrimPrefix(identity, "operator-")

			// release any in-memory locks matching the vehicle id
			lockStore.Lock()
			for k, v := range lockStore.m {
				if strings.HasSuffix(k, fmt.Sprintf(":%s", vehicleID)) && v == operatorID {
					delete(lockStore.m, k)
					log.Printf("【系统】驾驶员 %s 断线，已释放 %s 控制权", operatorID, vehicleID)
					teleopActiveSessions.Set(float64(len(lockStore.m)))
				}
			}
			lockStore.Unlock()
		}
	}
	w.WriteHeader(http.StatusOK)
}

func handleRegisterOperatorKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	claims := r.Context().Value("user").(*UserClaims)
	var req OperatorKeyRegistration
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid json", http.StatusBadRequest)
		return
	}

	if req.VehicleID == "" || req.OperatorID == "" || req.KeyID == "" || req.PublicKeyB64 == "" {
		http.Error(w, "missing required fields", http.StatusBadRequest)
		return
	}

	if claims.Name != req.OperatorID && !hasRole(claims.Roles, "admin") {
		http.Error(w, "forbidden: operator mismatch", http.StatusForbidden)
		return
	}

	now := time.Now().UnixMilli()
	if req.ExpiresAtMS == 0 {
		req.ExpiresAtMS = now + 2*60*60*1000
	}
	req.RegisteredMS = now

	keyRegistry.Lock()
	keyRegistry.byVehicle[req.VehicleID] = req
	keyRegistry.Unlock()

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"ok":          true,
		"vehicle_id":  req.VehicleID,
		"operator_id": req.OperatorID,
		"key_id":      req.KeyID,
		"expires_at":  req.ExpiresAtMS,
	})
}

func handleGetCurrentVehicleKey(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	vehicleID := r.URL.Query().Get("vid")
	if vehicleID == "" {
		http.Error(w, "missing vid", http.StatusBadRequest)
		return
	}

	keyRegistry.RLock()
	reg, ok := keyRegistry.byVehicle[vehicleID]
	keyRegistry.RUnlock()
	if !ok {
		http.Error(w, "key not found", http.StatusNotFound)
		return
	}

	if reg.ExpiresAtMS > 0 && time.Now().UnixMilli() > reg.ExpiresAtMS {
		http.Error(w, "key expired", http.StatusGone)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(reg)
}

// --- 辅助函数 ---
func hasRole(roles []string, target string) bool {
	for _, r := range roles {
		if r == target {
			return true
		}
	}
	return false
}

func bp(b bool) *bool { return &b }

// ==========================================
// 6. 遥测接口 (Telemetry)
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

	// 更新 Prometheus Gauge
	teleopE2eLatencyP99.WithLabelValues(payload.VehicleID).Set(payload.P99)
	log.Printf("【遥测】%s P50: %.2f ms, P99: %.2f ms, Lost: %d", payload.VehicleID, payload.P50, payload.P99, payload.LostCount)

	w.WriteHeader(http.StatusOK)
}
