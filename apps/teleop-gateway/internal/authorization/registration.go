package authorization

import (
	"context"
	"time"
)

// AwaitRegistration releases the worker claim without consuming retry attempts
// while the invitee completes Casdoor's native signup form.
func (s *Store) AwaitRegistration(ctx context.Context, op OnboardingOperation) error {
	tx, _, err := s.managementTx(ctx, op.ActorUserID, op.OrganizationID)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	status, code := "awaiting_registration", ""
	if time.Now().After(op.CreatedAt.Add(RegistrationLifetime)) {
		status, code = "failed", "REGISTRATION_EXPIRED"
	}
	result, err := tx.ExecContext(ctx, `UPDATE authz_onboarding_operations SET status=$2,stage='registration',
		attempts=0,error_code=$3,next_attempt_at=now()+interval '5 seconds',updated_at=now()
		WHERE operation_id=$1 AND kind='person' AND email='' AND status='running'`, op.ID, status, code)
	if err != nil {
		return err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return ErrConflict
	}
	return tx.Commit()
}
