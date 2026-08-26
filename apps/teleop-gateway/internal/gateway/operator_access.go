package gateway

import (
	"fmt"

	"github.com/livekit/protocol/auth"
)

type OperatorAccess string

const (
	ObserverAccess   OperatorAccess = "observer"
	ControllerAccess OperatorAccess = "controller"
)

func resolveOperatorAccess(claims *UserClaims, requested string) (OperatorAccess, error) {
	access := OperatorAccess(requested)
	if access == "" {
		if canControl(claims) {
			return ControllerAccess, nil
		}
		return ObserverAccess, nil
	}

	switch access {
	case ObserverAccess:
		if canObserve(claims) {
			return access, nil
		}
	case ControllerAccess:
		if canControl(claims) {
			return access, nil
		}
	default:
		return "", fmt.Errorf("unsupported access mode %q", requested)
	}
	return "", fmt.Errorf("access mode %q is not permitted", requested)
}

func canObserve(claims *UserClaims) bool {
	return hasRole(claims.Roles, "observer") || canControl(claims)
}

func canControl(claims *UserClaims) bool {
	return hasRole(claims.Roles, "controller") ||
		hasRole(claims.Roles, "supervisor") ||
		hasRole(claims.Roles, "operator") ||
		hasRole(claims.Roles, "admin")
}

func operatorVideoGrant(vehicleID string, access OperatorAccess) *auth.VideoGrant {
	return &auth.VideoGrant{
		RoomJoin:       true,
		Room:           "teleop-" + vehicleID,
		CanPublish:     bp(false),
		CanPublishData: bp(access == ControllerAccess),
		CanSubscribe:   bp(true),
	}
}
