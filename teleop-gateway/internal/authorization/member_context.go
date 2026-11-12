package authorization

import "context"

type MemberOrganization struct {
	Organization
	Role       Role     `json:"role"`
	CanManage  bool     `json:"can_manage"`
	Scope      Scope    `json:"scope"`
	VehicleIDs []string `json:"vehicle_ids"`
}

type MemberContext struct {
	Organizations []MemberOrganization `json:"organizations"`
}

// MemberContext discloses only active memberships, never all tenant records.
func (s *Store) MemberContext(ctx context.Context, userID string) (MemberContext, error) {
	result := MemberContext{Organizations: []MemberOrganization{}}
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT o.org_id,o.name,
		COALESCE(substring(p.v2 from 6),''),u.platform_admin OR COALESCE(p.v2='role:org_admin' AND p.v4='all',false),
		COALESCE(p.v4,'none'),CASE WHEN p.v4='selected' THEN p.v5 ELSE '' END
		FROM authz_organizations o
		JOIN authz_organization_memberships m ON m.org_id=o.org_id
		JOIN authz_users u ON u.user_id=m.user_id
		LEFT JOIN casbin_rule g ON g.ptype='g' AND g.v0='user:'||u.user_id::text AND g.v2='org:'||o.org_id::text
		LEFT JOIN casbin_rule p ON p.ptype='p' AND p.v0=g.v2 AND p.v1=g.v1 AND p.v3='vehicle.read'
		WHERE u.user_id=$1 AND u.status='active' AND m.status='active' AND o.status='active'
		ORDER BY o.org_id`, userID)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	byOrganization := make(map[string]int)
	for rows.Next() {
		var org MemberOrganization
		var vehicleID string
		if err := rows.Scan(&org.OrganizationID, &org.Name, &org.Role, &org.CanManage, &org.Scope, &vehicleID); err != nil {
			return result, err
		}
		if index, exists := byOrganization[org.OrganizationID]; exists {
			if vehicleID != "" {
				result.Organizations[index].VehicleIDs = append(result.Organizations[index].VehicleIDs, vehicleID)
			}
			continue
		}
		org.VehicleIDs = []string{}
		if vehicleID != "" {
			org.VehicleIDs = append(org.VehicleIDs, vehicleID)
		}
		byOrganization[org.OrganizationID] = len(result.Organizations)
		result.Organizations = append(result.Organizations, org)
	}
	return result, rows.Err()
}
