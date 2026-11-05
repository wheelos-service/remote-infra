package authorization

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"

	"github.com/casbin/casbin/v2"
	"github.com/casbin/casbin/v2/model"
	"github.com/google/uuid"
)

//go:embed model.conf
var modelText string

//go:embed migrations/001_authz.sql
var migrationText string

//go:embed migrations/002_management.sql
var managementMigrationText string

//go:embed migrations/003_onboarding.sql
var onboardingMigrationText string

//go:embed migrations/004_lifecycle.sql
var lifecycleMigrationText string

//go:embed migrations/005_device_recovery.sql
var recoveryMigrationText string

type Role string
type Scope string

const (
	RoleOrgAdmin       Role = "org_admin"
	RoleRemoteOperator Role = "remote_operator"
	RoleViewer         Role = "viewer"
	RoleMaintainer     Role = "maintainer"
	RoleDispatcher     Role = "dispatcher"

	ScopeAll      Scope = "all"
	ScopeSelected Scope = "selected"
	ScopeNone     Scope = "none"

	ActionVehicleRead         = "vehicle.read"
	ActionCameraLiveView      = "camera.live.view"
	ActionRemoteControl       = "remote_control.request"
	ActionVehicleHealthRead   = "vehicle.health.read"
	ActionVehicleDiagnose     = "vehicle.diagnostics.read"
	ActionTaskRead            = "task.read"
	ActionTaskManage          = "task.manage"
	ActionAuthorizationManage = "authorization.manage"
)

var (
	ErrInvalidAssignment     = errors.New("invalid role assignment")
	ErrInactiveLifecycle     = errors.New("organization, user, membership, or vehicle is not active")
	ErrNotOrganizationAdmin  = errors.New("actor is not an organization administrator")
	ErrSelfAssignment        = errors.New("self role assignment is not allowed")
	ErrLastOrganizationAdmin = errors.New("cannot remove the last organization administrator")
)

var roleActions = map[Role][]string{
	RoleOrgAdmin: {
		ActionVehicleRead,
		ActionAuthorizationManage,
	},
	RoleRemoteOperator: {
		ActionVehicleRead,
		ActionCameraLiveView,
		ActionRemoteControl,
	},
	RoleViewer: {
		ActionVehicleRead,
		ActionCameraLiveView,
	},
	RoleMaintainer: {
		ActionVehicleRead,
		ActionVehicleHealthRead,
		ActionVehicleDiagnose,
	},
	RoleDispatcher: {
		ActionVehicleRead,
		ActionTaskRead,
		ActionTaskManage,
	},
}

type Assignment struct {
	ActorUserID     string
	UserID          string
	OrganizationID  string
	Role            Role
	Scope           Scope
	VehicleIDs      []string
	ExpectedVersion *int64
}

type Store struct {
	db             *sql.DB
	managedSession *sql.Conn
	snapshot       atomic.Pointer[engineSnapshot]
	snapshotMu     sync.Mutex
}

type engineSnapshot struct {
	version  int64
	enforcer *casbin.Enforcer
	admins   map[string]struct{}
}

type policyRule struct {
	kind   string
	values []string
}

func NewStore(db *sql.DB) (*Store, error) {
	if db == nil {
		return nil, errors.New("authorization database is required")
	}
	snapshot, err := buildSnapshot(0, nil)
	if err != nil {
		return nil, err
	}
	store := &Store{db: db}
	store.snapshot.Store(snapshot)
	return store, nil
}

// NewManagedStore binds policy writes to the lifetime-lock session so losing
// the single-Gateway lock cannot leave an in-flight pooled policy writer.
func NewManagedStore(db *sql.DB, session *sql.Conn) (*Store, error) {
	if session == nil {
		return nil, errors.New("managed authorization requires the runtime lock connection")
	}
	store, err := NewStore(db)
	if err != nil {
		return nil, err
	}
	store.managedSession = session
	return store, nil
}

func (s *Store) beginWriteTx(ctx context.Context) (*sql.Tx, error) {
	options := &sql.TxOptions{Isolation: sql.LevelSerializable}
	if s.managedSession != nil {
		return s.managedSession.BeginTx(ctx, options)
	}
	return s.db.BeginTx(ctx, options)
}

func (s *Store) Migrate(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin authorization migration: %w", err)
	}
	defer tx.Rollback()

	for _, statement := range strings.Split(migrationText+"\n"+managementMigrationText+"\n"+onboardingMigrationText+"\n"+lifecycleMigrationText+"\n"+recoveryMigrationText, ";") {
		statement = strings.TrimSpace(statement)
		if statement == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("apply authorization migration: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit authorization migration: %w", err)
	}
	return nil
}

func (s *Store) Enforce(ctx context.Context, userID, organizationID, vehicleID, action string) (bool, error) {
	userID, err := canonicalUUID(userID)
	if err != nil {
		return false, fmt.Errorf("invalid user ID: %w", err)
	}
	organizationID, err = canonicalUUID(organizationID)
	if err != nil {
		return false, fmt.Errorf("invalid organization ID: %w", err)
	}
	if !validVehicleID(vehicleID) {
		return false, fmt.Errorf("invalid vehicle ID")
	}
	if !knownAction(action) {
		return false, nil
	}

	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelRepeatableRead,
		ReadOnly:  true,
	})
	if err != nil {
		return false, fmt.Errorf("begin authorization check: %w", err)
	}
	defer tx.Rollback()

	version, err := readVersion(ctx, tx, false)
	if err != nil {
		return false, err
	}
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err != nil {
		return false, err
	}
	active, err := activeVehicleMembership(ctx, tx, userID, organizationID, vehicleID)
	if err != nil {
		return false, err
	}
	if !active {
		return false, nil
	}

	allowed, err := snapshot.enforcer.Enforce(
		"user:"+userID,
		"org:"+organizationID,
		vehicleID,
		action,
		active,
	)
	if err != nil {
		return false, fmt.Errorf("evaluate authorization policy: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("finish authorization check: %w", err)
	}
	return allowed, nil
}

func (s *Store) AssignRole(ctx context.Context, assignment Assignment) (int64, error) {
	assignment, err := normalizeAssignment(assignment)
	if err != nil {
		return 0, err
	}
	if assignment.ActorUserID == assignment.UserID {
		return 0, ErrSelfAssignment
	}

	tx, err := s.beginWriteTx(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin role assignment: %w", err)
	}
	defer tx.Rollback()

	version, err := readVersion(ctx, tx, true)
	if err != nil {
		return 0, err
	}
	if assignment.ExpectedVersion != nil && *assignment.ExpectedVersion != version {
		return 0, ErrConflict
	}
	snapshot, err := s.snapshotFor(ctx, tx, version)
	if err != nil {
		return 0, err
	}
	if err := requireManager(ctx, tx, snapshot, assignment.ActorUserID, assignment.OrganizationID); err != nil {
		return 0, err
	}
	active, err := activeMember(ctx, tx, assignment.OrganizationID, assignment.UserID)
	if err != nil {
		return 0, err
	}
	if !active {
		return 0, ErrInactiveLifecycle
	}
	for _, vehicleID := range assignment.VehicleIDs {
		active, err := activeVehicle(ctx, tx, assignment.OrganizationID, vehicleID)
		if err != nil {
			return 0, err
		}
		if !active {
			return 0, ErrInactiveLifecycle
		}
	}

	oldAdministrator := snapshot.canManageOrganization(assignment.UserID, assignment.OrganizationID)
	newAdministrator := assignment.Role == RoleOrgAdmin && assignment.Scope == ScopeAll
	if oldAdministrator && !newAdministrator {
		hasAnotherAdmin, err := hasOtherOrganizationAdmin(ctx, tx, snapshot, assignment.OrganizationID, assignment.UserID)
		if err != nil {
			return 0, err
		}
		if !hasAnotherAdmin {
			return 0, ErrLastOrganizationAdmin
		}
	}

	grantID := "grant:" + uuid.NewString()
	rules := assignmentRules(assignment, grantID)
	if err := replaceUserAssignment(ctx, tx, assignment, rules); err != nil {
		return 0, err
	}
	nextVersion := version + 1
	if _, err := tx.ExecContext(ctx,
		`UPDATE authz_authorization_state SET version = $1 WHERE state_key = 1`, nextVersion); err != nil {
		return 0, fmt.Errorf("advance authorization version: %w", err)
	}

	eventID := uuid.NewString()
	details, err := json.Marshal(struct {
		Role       Role     `json:"role"`
		Scope      Scope    `json:"scope"`
		VehicleIDs []string `json:"vehicle_ids"`
	}{assignment.Role, assignment.Scope, assignment.VehicleIDs})
	if err != nil {
		return 0, fmt.Errorf("encode authorization audit: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO authz_audit_events
			(event_id, org_id, actor_user_id, subject_user_id, event_type, authorization_version, details)
		VALUES ($1, $2, $3, $4, 'role_assigned', $5, $6::jsonb)`,
		eventID, assignment.OrganizationID, assignment.ActorUserID, assignment.UserID, nextVersion, string(details)); err != nil {
		return 0, fmt.Errorf("write authorization audit event: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO authz_outbox
			(event_id, org_id, authorization_version, event_type, payload)
		VALUES ($1, $2, $3, 'authorization.changed', $4::jsonb)`,
		eventID, assignment.OrganizationID, nextVersion, string(details)); err != nil {
		return 0, fmt.Errorf("write authorization outbox event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit role assignment: %w", err)
	}
	return nextVersion, nil
}

func (s *Store) Version(ctx context.Context) (int64, error) {
	return readVersion(ctx, s.db, false)
}

func (s *Store) snapshotFor(ctx context.Context, queryer policyQueryer, version int64) (*engineSnapshot, error) {
	current := s.snapshot.Load()
	if current != nil && current.version == version {
		return current, nil
	}

	s.snapshotMu.Lock()
	defer s.snapshotMu.Unlock()
	current = s.snapshot.Load()
	if current != nil && current.version == version {
		return current, nil
	}
	snapshot, err := loadSnapshot(ctx, queryer, version)
	if err != nil {
		return nil, err
	}
	if current == nil || current.version < version {
		s.snapshot.Store(snapshot)
	}
	return snapshot, nil
}

func loadSnapshot(ctx context.Context, queryer policyQueryer, version int64) (*engineSnapshot, error) {
	m, err := model.NewModelFromString(modelText)
	if err != nil {
		return nil, fmt.Errorf("load embedded Casbin model: %w", err)
	}
	adapter := &policyAdapter{ctx: ctx, db: queryer}
	if err := adapter.LoadPolicy(m); err != nil {
		return nil, fmt.Errorf("load authorization policy snapshot: %w", err)
	}
	rules := make([]policyRule, 0)
	for _, section := range []string{"p", "g"} {
		policies := m[section][section].Policy
		for _, policy := range policies {
			rules = append(rules, policyRule{kind: section, values: append([]string(nil), policy...)})
		}
	}
	return buildSnapshot(version, rules)
}

func buildSnapshot(version int64, rules []policyRule) (*engineSnapshot, error) {
	if version < 0 {
		return nil, errors.New("authorization version cannot be negative")
	}
	grants := make(map[string]grantRecord)
	userOrgGrants := make(map[string]string)
	policiesByGrant := make(map[string]map[string]struct{})
	roleByGrant := make(map[string]Role)
	scopeByGrant := make(map[string]Scope)
	vehiclesByGrant := make(map[string]map[string]struct{})

	for _, rule := range rules {
		switch rule.kind {
		case "g":
			if len(rule.values) != 3 {
				return nil, errors.New("invalid authorization grouping policy")
			}
			userID, err := parseNamespacedUUID(rule.values[0], "user:")
			if err != nil {
				return nil, errors.New("invalid authorization grouping subject")
			}
			grantID, err := parseNamespacedUUID(rule.values[1], "grant:")
			if err != nil {
				return nil, errors.New("invalid authorization grouping grant")
			}
			orgID, err := parseNamespacedUUID(rule.values[2], "org:")
			if err != nil {
				return nil, errors.New("invalid authorization grouping domain")
			}
			grantKey := orgID + "\x00" + grantID
			if _, exists := grants[grantKey]; exists {
				return nil, errors.New("duplicate authorization grant")
			}
			userOrgKey := orgID + "\x00" + userID
			if _, exists := userOrgGrants[userOrgKey]; exists {
				return nil, errors.New("multiple role assignments for one organization member")
			}
			grants[grantKey] = grantRecord{userID: userID, grantID: grantID, orgID: orgID}
			userOrgGrants[userOrgKey] = grantKey
		case "p":
			if len(rule.values) != 6 {
				return nil, errors.New("invalid authorization policy")
			}
			orgID, err := parseNamespacedUUID(rule.values[0], "org:")
			if err != nil {
				return nil, errors.New("invalid authorization policy domain")
			}
			grantID, err := parseNamespacedUUID(rule.values[1], "grant:")
			if err != nil {
				return nil, errors.New("invalid authorization policy grant")
			}
			role := Role(strings.TrimPrefix(rule.values[2], "role:"))
			action := rule.values[3]
			scope := Scope(rule.values[4])
			vehicleID := rule.values[5]
			if !roleHasAction(role, action) {
				return nil, errors.New("authorization policy exceeds fixed role capabilities")
			}
			grantKey := orgID + "\x00" + grantID
			key := strings.Join(rule.values, "\x00")
			if _, exists := policiesByGrant[grantKey]; !exists {
				policiesByGrant[grantKey] = make(map[string]struct{})
			}
			if _, exists := policiesByGrant[grantKey][key]; exists {
				return nil, errors.New("duplicate authorization policy")
			}
			policiesByGrant[grantKey][key] = struct{}{}
			if previous, exists := roleByGrant[grantKey]; exists && previous != role {
				return nil, errors.New("one grant cannot contain multiple roles")
			}
			if previous, exists := scopeByGrant[grantKey]; exists && previous != scope {
				return nil, errors.New("one role assignment cannot mix vehicle scopes")
			}
			roleByGrant[grantKey] = role
			scopeByGrant[grantKey] = scope
			if scope == ScopeAll {
				if vehicleID != "*" {
					return nil, errors.New("all-vehicle policy must use the all scope marker")
				}
			} else if scope == ScopeSelected {
				if !validVehicleID(vehicleID) || vehicleID == "*" {
					return nil, errors.New("selected policy must name a vehicle")
				}
				if _, exists := vehiclesByGrant[grantKey]; !exists {
					vehiclesByGrant[grantKey] = make(map[string]struct{})
				}
				vehiclesByGrant[grantKey][vehicleID] = struct{}{}
			} else if scope == ScopeNone {
				if vehicleID != "" || role == RoleOrgAdmin {
					return nil, errors.New("unassigned scope cannot name a vehicle or grant organization administration")
				}
			} else {
				return nil, errors.New("unknown authorization vehicle scope")
			}
		default:
			return nil, errors.New("unknown authorization policy type")
		}
	}

	admins := make(map[string]struct{})
	for grantKey, grant := range grants {
		role, hasRole := roleByGrant[grantKey]
		scope, hasScope := scopeByGrant[grantKey]
		if !hasRole || !hasScope {
			return nil, errors.New("authorization grant has no role policy")
		}
		vehicles := []string{"*"}
		if scope == ScopeNone {
			vehicles = []string{""}
		}
		if scope == ScopeSelected {
			vehicles = vehicles[:0]
			for vehicleID := range vehiclesByGrant[grantKey] {
				vehicles = append(vehicles, vehicleID)
			}
			if len(vehicles) == 0 {
				return nil, errors.New("selected authorization scope has no vehicles")
			}
		}
		expected := make(map[string]struct{})
		for _, action := range roleActions[role] {
			for _, vehicleID := range vehicles {
				expected[strings.Join([]string{
					"org:" + grant.orgID, "grant:" + grant.grantID, "role:" + string(role),
					action, string(scope), vehicleID,
				}, "\x00")] = struct{}{}
			}
		}
		actual := policiesByGrant[grantKey]
		if len(actual) != len(expected) {
			return nil, errors.New("incomplete or excessive role policy set")
		}
		for key := range expected {
			if _, exists := actual[key]; !exists {
				return nil, errors.New("role policy set does not match fixed role capabilities")
			}
		}
		if role == RoleOrgAdmin && scope == ScopeAll {
			admins[grant.orgID+"\x00"+grant.userID] = struct{}{}
		}
	}
	for grantKey := range policiesByGrant {
		if _, exists := grants[grantKey]; !exists {
			return nil, errors.New("authorization policy has no member grant")
		}
	}

	m, err := model.NewModelFromString(modelText)
	if err != nil {
		return nil, fmt.Errorf("load embedded Casbin model: %w", err)
	}
	for _, rule := range rules {
		section := rule.kind
		if err := m.AddPolicy(section, section, rule.values); err != nil {
			return nil, fmt.Errorf("add authorization %s policy to Casbin model: %w", rule.kind, err)
		}
	}
	// Membership is checked transactionally against the requested organization
	// and active vehicle before Casbin receives this trusted lifecycle fact.
	// Keep the baseline in the engine, without rewriting persisted assignments.
	for _, action := range []string{ActionVehicleRead, ActionCameraLiveView, ActionTaskRead} {
		if err := m.AddPolicy("p", "p", []string{"*", "active-member", "member", action, "all", "*"}); err != nil {
			return nil, fmt.Errorf("add organization member baseline: %w", err)
		}
	}
	enforcer, err := casbin.NewEnforcer(m)
	if err != nil {
		return nil, fmt.Errorf("create authorization enforcer: %w", err)
	}
	if err := enforcer.BuildRoleLinks(); err != nil {
		return nil, fmt.Errorf("build authorization role links: %w", err)
	}
	return &engineSnapshot{version: version, enforcer: enforcer, admins: admins}, nil
}

type grantRecord struct {
	userID  string
	grantID string
	orgID   string
}

func (snapshot *engineSnapshot) canManageOrganization(userID, organizationID string) bool {
	_, ok := snapshot.admins[organizationID+"\x00"+userID]
	return ok
}

func normalizeAssignment(assignment Assignment) (Assignment, error) {
	var err error
	assignment.ActorUserID, err = canonicalUUID(assignment.ActorUserID)
	if err != nil {
		return Assignment{}, fmt.Errorf("%w: invalid actor user ID", ErrInvalidAssignment)
	}
	assignment.UserID, err = canonicalUUID(assignment.UserID)
	if err != nil {
		return Assignment{}, fmt.Errorf("%w: invalid user ID", ErrInvalidAssignment)
	}
	assignment.OrganizationID, err = canonicalUUID(assignment.OrganizationID)
	if err != nil {
		return Assignment{}, fmt.Errorf("%w: invalid organization ID", ErrInvalidAssignment)
	}
	if _, ok := roleActions[assignment.Role]; !ok {
		return Assignment{}, fmt.Errorf("%w: role is not assignable", ErrInvalidAssignment)
	}
	switch assignment.Scope {
	case ScopeNone:
		if len(assignment.VehicleIDs) != 0 || assignment.Role == RoleOrgAdmin {
			return Assignment{}, fmt.Errorf("%w: unassigned scope cannot include vehicles or organization administration", ErrInvalidAssignment)
		}
	case ScopeAll:
		if len(assignment.VehicleIDs) != 0 {
			return Assignment{}, fmt.Errorf("%w: all scope cannot include selected vehicles", ErrInvalidAssignment)
		}
	case ScopeSelected:
		if len(assignment.VehicleIDs) == 0 {
			return Assignment{}, fmt.Errorf("%w: selected scope requires vehicles", ErrInvalidAssignment)
		}
		assignment.VehicleIDs = append([]string(nil), assignment.VehicleIDs...)
		for _, vehicleID := range assignment.VehicleIDs {
			if !validVehicleID(vehicleID) || vehicleID == "*" {
				return Assignment{}, fmt.Errorf("%w: invalid selected vehicle ID", ErrInvalidAssignment)
			}
		}
		sort.Strings(assignment.VehicleIDs)
		for i := 1; i < len(assignment.VehicleIDs); i++ {
			if assignment.VehicleIDs[i] == assignment.VehicleIDs[i-1] {
				return Assignment{}, fmt.Errorf("%w: duplicate selected vehicle", ErrInvalidAssignment)
			}
		}
	default:
		return Assignment{}, fmt.Errorf("%w: unknown vehicle scope", ErrInvalidAssignment)
	}
	return assignment, nil
}

func assignmentRules(assignment Assignment, grantID string) []policyRule {
	vehicles := []string{"*"}
	if assignment.Scope == ScopeNone {
		vehicles = []string{""}
	}
	if assignment.Scope == ScopeSelected {
		vehicles = assignment.VehicleIDs
	}
	rules := []policyRule{{
		kind:   "g",
		values: []string{"user:" + assignment.UserID, grantID, "org:" + assignment.OrganizationID},
	}}
	for _, action := range roleActions[assignment.Role] {
		for _, vehicleID := range vehicles {
			rules = append(rules, policyRule{
				kind: "p",
				values: []string{
					"org:" + assignment.OrganizationID,
					grantID,
					"role:" + string(assignment.Role),
					action,
					string(assignment.Scope),
					vehicleID,
				},
			})
		}
	}
	return rules
}

func replaceUserAssignment(ctx context.Context, tx *sql.Tx, assignment Assignment, rules []policyRule) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT v1 FROM casbin_rule
		WHERE ptype = 'g' AND v0 = $1 AND v2 = $2`, "user:"+assignment.UserID, "org:"+assignment.OrganizationID)
	if err != nil {
		return fmt.Errorf("read prior authorization grants: %w", err)
	}
	var oldGrants []string
	for rows.Next() {
		var grant string
		if err := rows.Scan(&grant); err != nil {
			rows.Close()
			return fmt.Errorf("scan prior authorization grant: %w", err)
		}
		oldGrants = append(oldGrants, grant)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read prior authorization grants: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close prior authorization grants: %w", err)
	}
	for _, grant := range oldGrants {
		if _, err := tx.ExecContext(ctx,
			`DELETE FROM casbin_rule WHERE ptype = 'p' AND v0 = $1 AND v1 = $2`,
			"org:"+assignment.OrganizationID, grant); err != nil {
			return fmt.Errorf("delete prior role policies: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx,
		`DELETE FROM casbin_rule WHERE ptype = 'g' AND v0 = $1 AND v2 = $2`,
		"user:"+assignment.UserID, "org:"+assignment.OrganizationID); err != nil {
		return fmt.Errorf("delete prior role grant: %w", err)
	}
	for _, rule := range rules {
		values := append(append([]string(nil), rule.values...), "", "", "", "", "", "")
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO casbin_rule (ptype, v0, v1, v2, v3, v4, v5)
			VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			rule.kind, values[0], values[1], values[2], values[3], values[4], values[5]); err != nil {
			return fmt.Errorf("persist authorization policy: %w", err)
		}
	}
	return nil
}

type versionQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readVersion(ctx context.Context, queryer versionQueryer, lock bool) (int64, error) {
	statement := `SELECT version FROM authz_authorization_state WHERE state_key = 1`
	if lock {
		statement += ` FOR UPDATE`
	}
	var version int64
	if err := queryer.QueryRowContext(ctx, statement).Scan(&version); err != nil {
		return 0, fmt.Errorf("read authorization version: %w", err)
	}
	return version, nil
}

func activeMember(ctx context.Context, tx *sql.Tx, organizationID, userID string) (bool, error) {
	var active bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM authz_organizations o
			JOIN authz_users u ON u.user_id = $2
			JOIN authz_organization_memberships m ON m.org_id = o.org_id AND m.user_id = u.user_id
			WHERE o.org_id = $1 AND o.status = 'active' AND u.status = 'active' AND m.status = 'active'
		)`, organizationID, userID).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("check active organization membership: %w", err)
	}
	return active, nil
}

func activeVehicleMembership(ctx context.Context, tx *sql.Tx, userID, organizationID, vehicleID string) (bool, error) {
	var active bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM authz_organizations o
			JOIN authz_users u ON u.user_id = $2
			JOIN authz_organization_memberships m ON m.org_id = o.org_id AND m.user_id = u.user_id
			JOIN authz_vehicles v ON v.org_id = o.org_id AND v.vehicle_id = $3
			WHERE o.org_id = $1
			  AND o.status = 'active' AND u.status = 'active'
			  AND m.status = 'active' AND v.status = 'active'
		)`, organizationID, userID, vehicleID).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("check active authorization resources: %w", err)
	}
	return active, nil
}

func activeVehicle(ctx context.Context, tx *sql.Tx, organizationID, vehicleID string) (bool, error) {
	var active bool
	err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM authz_organizations o
			JOIN authz_vehicles v ON v.org_id = o.org_id
			WHERE o.org_id = $1 AND v.vehicle_id = $2
			  AND o.status = 'active' AND v.status = 'active'
		)`, organizationID, vehicleID).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("check active vehicle scope: %w", err)
	}
	return active, nil
}

func hasOtherOrganizationAdmin(ctx context.Context, tx *sql.Tx, snapshot *engineSnapshot, organizationID, excludedUserID string) (bool, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT m.user_id::text
		FROM authz_organization_memberships m
		JOIN authz_users u ON u.user_id = m.user_id
		WHERE m.org_id = $1 AND m.status = 'active' AND u.status = 'active' AND m.user_id <> $2`,
		organizationID, excludedUserID)
	if err != nil {
		return false, fmt.Errorf("find remaining organization administrators: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return false, fmt.Errorf("scan organization member: %w", err)
		}
		if snapshot.canManageOrganization(userID, organizationID) {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("read organization members: %w", err)
	}
	return false, nil
}

func canonicalUUID(value string) (string, error) {
	id, err := uuid.Parse(value)
	if err != nil {
		return "", err
	}
	return id.String(), nil
}

func parseNamespacedUUID(value, prefix string) (string, error) {
	if !strings.HasPrefix(value, prefix) {
		return "", errors.New("unexpected namespace")
	}
	return canonicalUUID(strings.TrimPrefix(value, prefix))
}

func validVehicleID(value string) bool {
	if len(value) == 0 || len(value) > 128 {
		return false
	}
	for _, r := range value {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' || r == '_' || r == '.') {
			return false
		}
	}
	return true
}

func knownAction(action string) bool {
	for _, actions := range roleActions {
		for _, candidate := range actions {
			if candidate == action {
				return true
			}
		}
	}
	return false
}

func roleHasAction(role Role, action string) bool {
	for _, candidate := range roleActions[role] {
		if candidate == action {
			return true
		}
	}
	return false
}
