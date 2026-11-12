# Administration

The release configures managed authorization automatically. Sign in at the
console's administrator entry (`/#/admin`) with the initial account from the
private `administrator.txt` file. Select the organization before managing its
people or vehicles. The first organization is named **Fleet**.

## Invite a person

1. Open **人员管理**, enter a username, and choose the role.
2. Select **生成注册链接**, then **复制注册链接** when ready.
3. Share the single-use signup link privately with that person. They set their
   password on the login service and then sign into the console.
4. Check **接入与邀请进度**. Allow a few seconds after signup for membership
   to appear. An invitation that has not completed grants no access.

No email service is required. Usernames contain 2–64 ASCII characters, begin
with a letter, and may contain letters, digits, and single hyphens or underscores.
Signup links expire after seven days; issue a new invitation after expiry.
Treat invitation links as credentials. Never put them in public issue reports.

New operators have no driving scope. Assign their permitted vehicles separately
in **权限管理**. Inviting another administrator requires a platform administrator.

## Roles and vehicle access

Each person has one assigned role per organization. Replacing it also replaces
its vehicle scope. Roles are separate capabilities, not an increasing hierarchy.

| Role or identity | Observation | Driving permission | Administration |
| --- | --- | --- | --- |
| Active organization member / viewer | All active vehicles in that organization | None | None |
| Operator | All active vehicles in that organization | Selected vehicles, or all, subject to session checks and release limits | None |
| Organization administrator | All active vehicles in that organization | No implicit driving permission | People, vehicles, and permissions in that organization |
| Platform administrator | Ordinary vehicle APIs still require organization membership | Separate qualifying operator assignment required | Manage organizations and their administration |
| Vehicle machine identity | Its own machine resources | Cannot acquire a human driving session | None |

For an operator, `none` grants no driving access, `selected` grants the chosen
vehicles, and `all` covers the organization's vehicles. Scope does not restrict
the baseline observation access of an active member. Viewer `all` does not
grant driving. Managed native driving remains disabled in this release;
see [release capabilities](compatibility.md).

## Change or remove access

Use **权限管理** to change a person's role and vehicle scope. Remove membership
to remove organization observation access: deleting only a role assignment
leaves the active-member observation baseline intact. Changes in one organization
do not remove the person's memberships in others.

Self-assignment/self-removal and removal of the last organization administrator
are restricted. Platform administrators create or disable organizations.
Disabling a vehicle or organization affects its identities and access; it is
not a temporary logout or proof that a vehicle has stopped.

The dashboard limits administrator delegation, but the current assignment API
also permits an organization administrator to grant that role to another active
member of the same organization. Treat organization administrators as trusted
delegators; this does not grant platform administration.

A successful permission change confirms the stored policy change. LiveKit and
Redis cleanup can lag or fail, and removal does not guarantee immediate
disconnection of an existing media participant. For access-sensitive maintenance,
end active sessions and verify disconnection separately. Do not clear runtime
fences or delete a vehicle to force handover.

## Register vehicles and resolve pending work

Follow [Register a vehicle](add-vehicle.md) to approve a machine code from a
prepared vehicle. Registration does not grant a human operator driving access.
The fleet stays empty until vehicles are registered and publish telemetry.

Check **接入与邀请进度** for invitation and vehicle provisioning status.
Retry only a failed operation after its cause is resolved; an uncertain request
may already have succeeded. Preserve the existing operation and device identity
when recovering a vehicle. If setup is unavailable, have the server operator
run the deployment verification and inspect Gateway/Casdoor logs privately.
