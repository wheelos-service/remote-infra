package gateway

import (
	"context"
	"errors"
	"log"
	"mime"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

type requestIDContextKey struct{}

func withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id, _ := r.Context().Value(requestIDContextKey{}).(string)
		if id == "" {
			id = uuid.NewString()
			r = r.WithContext(context.WithValue(r.Context(), requestIDContextKey{}, id))
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r)
	})
}

func writeDiagnosticError(w http.ResponseWriter, r *http.Request, message, code string, status int) {
	id, _ := r.Context().Value(requestIDContextKey{}).(string)
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Error-Code", code)
	w.Header().Add("Vary", "Accept")
	log.Printf("gateway_request_denied request_id=%s code=%s status=%d method=%s", id, code, status, r.Method)
	if acceptsDiagnosticJSON(r.Header.Get("Accept")) {
		writeJSON(w, status, struct {
			Error     string `json:"error"`
			Code      string `json:"code"`
			RequestID string `json:"request_id"`
		}{message, code, id})
		return
	}
	http.Error(w, message, status)
}

func logAuthenticationFailure(r *http.Request, err error) {
	reason := "AUTHENTICATION_REJECTED"
	var failure authenticationFailure
	if errors.As(err, &failure) {
		reason = string(failure)
	}
	id, _ := r.Context().Value(requestIDContextKey{}).(string)
	log.Printf("gateway_authentication_rejected request_id=%s reason=%s", id, reason)
}

func acceptsDiagnosticJSON(accept string) bool {
	for _, entry := range strings.Split(accept, ",") {
		mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(entry))
		if err != nil || mediaType != "application/json" {
			continue
		}
		if q, exists := params["q"]; exists {
			quality, err := strconv.ParseFloat(q, 64)
			if err != nil || !(quality > 0 && quality <= 1) {
				continue
			}
		}
		return true
	}
	return false
}
