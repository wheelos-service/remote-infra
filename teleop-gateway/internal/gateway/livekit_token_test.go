package gateway

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	"github.com/livekit/protocol/auth"
)

func TestVehicleTokenAllowsFeedbackButObserverCannotPublish(t *testing.T) {
	previousKey, previousSecret := lkApiKey, lkApiSecret
	lkApiKey, lkApiSecret = "test-key", "local-test-signing-key-not-a-production-credential"
	t.Cleanup(func() { lkApiKey, lkApiSecret = previousKey, previousSecret })
	vehicle, err := issueVehicleToken("car-1")
	if err != nil {
		t.Fatal(err)
	}
	observer, err := issueOperatorToken("car-1", "alice", ObserverAccess)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		token, identity string
		publish         bool
	}{
		{vehicle, "vehicle-car-1", true}, {observer, "operator-alice", false},
	} {
		parts := strings.Split(test.token, ".")
		if len(parts) != 3 {
			t.Fatal("missing JWT")
		}
		raw, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Fatal(err)
		}
		var payload struct {
			Subject string `json:"sub"`
			Video   struct {
				Room           string `json:"room"`
				CanPublishData bool   `json:"canPublishData"`
				CanPublish     bool   `json:"canPublish"`
			} `json:"video"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Subject != test.identity || payload.Video.Room != "teleop-car-1" ||
			payload.Video.CanPublish != test.publish || payload.Video.CanPublishData != test.publish {
			t.Fatal("vehicle feedback and observer permissions must remain separated")
		}
	}
}

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
