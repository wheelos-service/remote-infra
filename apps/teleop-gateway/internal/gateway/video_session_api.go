package gateway

import (
	"errors"
	"net/http"
	"os"
	"strconv"
	"time"
)

func handleAcquireVideo(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !canObserve(claims) || !vehicleAuthorizer.Authorize(claims, vehicleID, ObservePermission) {
		http.Error(w, "forbidden: observer role required", http.StatusForbidden)
		return
	}
	session, err := videoSessions.AcquireViewer(r.Context(), vehicleID)
	if err != nil {
		writeVideoSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: vehicleID, SessionID: session.SessionID, Event: "video_acquire", Result: "success"})
	writeJSON(w, http.StatusOK, session)
}

func handleReleaseVideo(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	session, err := videoSessions.ReleaseViewer(r.Context(), r.PathValue("session_id"))
	if err != nil {
		writeVideoSessionError(w, err)
		return
	}
	recordAudit(r.Context(), AuditEvent{OperatorID: claims.Name, VehicleID: session.VehicleID, SessionID: r.PathValue("session_id"), Event: "video_release", Result: "success"})
	w.WriteHeader(http.StatusNoContent)
}

func handleGetVideo(w http.ResponseWriter, r *http.Request) {
	claims := r.Context().Value("user").(*UserClaims)
	vehicleID := r.PathValue("vehicle_id")
	if !hasRole(claims.Roles, "vehicle") && (!canObserve(claims) || !vehicleAuthorizer.Authorize(claims, vehicleID, ObservePermission)) {
		http.Error(w, "forbidden: observer role required", http.StatusForbidden)
		return
	}
	session, err := videoSessions.Get(r.Context(), vehicleID)
	if err != nil {
		writeVideoSessionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, session)
}

func videoGracePeriod() time.Duration {
	seconds, err := strconv.Atoi(os.Getenv("VIDEO_GRACE_SECONDS"))
	if err != nil || seconds < 0 {
		return 45 * time.Second
	}
	return time.Duration(seconds) * time.Second
}

func writeVideoSessionError(w http.ResponseWriter, err error) {
	if errors.Is(err, ErrVideoSessionNotFound) {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	http.Error(w, "video session unavailable", http.StatusServiceUnavailable)
}
