package gateway

import (
	"testing"

	"github.com/livekit/protocol/auth"
)

func TestVehicleTokenAllowsMonitoringOnlyInItsOwnRoom(t *testing.T) {
	previousKey, previousSecret := lkApiKey, lkApiSecret
	lkApiKey, lkApiSecret = "test-key", "test-secret-for-vehicle-monitoring"
	t.Cleanup(func() { lkApiKey, lkApiSecret = previousKey, previousSecret })

	token, err := issueVehicleToken("car-001")
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := auth.ParseAPIToken(token)
	if err != nil {
		t.Fatal(err)
	}
	claims, grants, err := verifier.Verify(lkApiSecret)
	if err != nil {
		t.Fatal(err)
	}
	if claims.Subject != "vehicle-car-001" || grants.Video == nil ||
		grants.Video.Room != "teleop-car-001" || !grants.Video.RoomJoin {
		t.Fatal("vehicle token must be scoped to its own identity and room")
	}
	if grants.Video.CanPublishData == nil || !*grants.Video.CanPublishData {
		t.Fatal("vehicle token must permit monitoring data publication")
	}
}
