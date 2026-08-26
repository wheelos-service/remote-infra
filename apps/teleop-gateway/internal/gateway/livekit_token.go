package gateway

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/livekit/protocol/auth"
)

func issueOperatorToken(vehicleID, operatorID string, access OperatorAccess) (string, error) {
	accessToken := auth.NewAccessToken(lkApiKey, lkApiSecret)
	accessToken.AddGrant(operatorVideoGrant(vehicleID, access)).
		SetIdentity("operator-" + operatorID).
		SetValidFor(15 * time.Minute)

	token, err := accessToken.ToJWT()
	if err != nil {
		return "", fmt.Errorf("create operator LiveKit token: %w", err)
	}
	return token, nil
}

func issueVehicleToken(vehicleID string) (string, error) {
	accessToken := auth.NewAccessToken(lkApiKey, lkApiSecret)
	accessToken.AddGrant(&auth.VideoGrant{
		RoomJoin:       true,
		Room:           "teleop-" + vehicleID,
		CanPublish:     bp(true),
		CanPublishData: bp(false),
		CanSubscribe:   bp(true),
	}).SetIdentity("vehicle-" + vehicleID).SetValidFor(vehicleLiveKitTokenTTL())

	token, err := accessToken.ToJWT()
	if err != nil {
		return "", fmt.Errorf("create vehicle LiveKit token: %w", err)
	}
	return token, nil
}

func vehicleLiveKitTokenTTL() time.Duration {
	minutes, err := strconv.Atoi(os.Getenv("VEHICLE_LIVEKIT_TOKEN_TTL_MINUTES"))
	if err != nil || minutes < 15 || minutes > 30 {
		minutes = 30
	}
	return time.Duration(minutes) * time.Minute
}
