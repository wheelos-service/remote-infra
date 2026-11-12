package authorization

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/casbin/casbin/v2/model"
	"github.com/casbin/casbin/v2/persist"
)

var errPolicyWritesRequireTransaction = errors.New("authorization policies must be changed through Store.AssignRole")

type policyQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

type policyAdapter struct {
	ctx context.Context
	db  policyQueryer
}

var _ persist.Adapter = (*policyAdapter)(nil)

func (a *policyAdapter) LoadPolicy(m model.Model) error {
	rows, err := a.db.QueryContext(a.ctx, `
		SELECT ptype, v0, v1, v2, v3, v4, v5
		FROM casbin_rule
		ORDER BY ptype, id`)
	if err != nil {
		return fmt.Errorf("load casbin policies: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var ptype string
		var values [6]string
		if err := rows.Scan(&ptype, &values[0], &values[1], &values[2], &values[3], &values[4], &values[5]); err != nil {
			return fmt.Errorf("scan casbin policy: %w", err)
		}

		section, key, fields := "p", "p", values[:]
		if ptype == "g" {
			section, key, fields = "g", "g", values[:3]
		} else if ptype != "p" {
			return fmt.Errorf("unsupported casbin policy type %q", ptype)
		}
		if err := m.AddPolicy(section, key, fields); err != nil {
			return fmt.Errorf("add casbin %s policy to model: %w", ptype, err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("read casbin policies: %w", err)
	}
	return nil
}

func (*policyAdapter) SavePolicy(model.Model) error { return errPolicyWritesRequireTransaction }

func (*policyAdapter) AddPolicy(string, string, []string) error {
	return errPolicyWritesRequireTransaction
}

func (*policyAdapter) RemovePolicy(string, string, []string) error {
	return errPolicyWritesRequireTransaction
}

func (*policyAdapter) RemoveFilteredPolicy(string, string, int, ...string) error {
	return errPolicyWritesRequireTransaction
}
