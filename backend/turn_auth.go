package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"fmt"
	"time"
)

// GenerateTURNToken generates credentials for Coturn REST API (short-lived credentials).
// WebRTC clients use this username and password to authenticate with the TURN server.
//
// secret: the static-auth-secret configured in turnserver.conf
// userID: the user/device ID
// ttl: how long the token is valid for
func GenerateTURNToken(secret string, userID string, ttl time.Duration) (string, string) {
	// 1. Calculate Unix timestamp for expiration
	timestamp := time.Now().Add(ttl).Unix()

	// 2. Format username: <timestamp>:<userid>
	username := fmt.Sprintf("%d:%s", timestamp, userID)

	// 3. HMAC-SHA1 of username using the shared secret
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	signature := mac.Sum(nil)

	// 4. Base64 encode the signature to get the password
	password := base64.StdEncoding.EncodeToString(signature)

	return username, password
}

// Example usage to be integrated into an HTTP handler:
/*
func (s *Server) turnCredsHandler(w http.ResponseWriter, r *http.Request) {
    userID := r.URL.Query().Get("vid")
    secret := os.Getenv("TURN_SECRET")

    username, password := GenerateTURNToken(secret, userID, 24 * time.Hour)

    json.NewEncoder(w).Encode(map[string]string{
        "uris": []string{
            "turn:turn.teleop.local:3478",
            "turn:turn.teleop.local:5349",
        },
        "username": username,
        "password": password,
    })
}
*/
