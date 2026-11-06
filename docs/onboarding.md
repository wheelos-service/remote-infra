# First administrator, users and vehicles

Use this guide after [deployment](deployment.md). Ask the deployment operator for
the application URL and initial administrator credentials. If the environment
uses a private CA, trust its public certificate before signing in.

## 1. Log in as the first administrator

The deployment script creates the first organization and platform administrator.
The operator can find the login URL, email and initial password in
`administrator.txt` inside the deployment's protected state directory.

1. Open the application URL followed by `/#/admin`.
2. Click **管理员登录** and enter the email and password on the login page.
3. After returning to the application, select the organization.
4. Confirm that **人员管理**, **车辆管理** and **权限管理** are available.

Use the platform administrator account from `administrator.txt`; the Casdoor
system-console administrator is a separate account. If the initial account or
organization is missing, ask the deployment operator to complete bootstrap.

## 2. Invite other users

As the administrator:

1. Open **人员管理** → **添加人员**.
2. Enter the person's name and email.
3. Keep the default **查看者 / 无操作权限** for someone who only needs monitoring.
   Expand **初始权限** if a different role or vehicle scope is required.
4. Click **添加人员并发送邀请**. Follow the result under **接入与邀请进度**.

The invited user then:

1. Opens the invitation email and follows its account-setup link.
2. Completes email verification and sets a password.
3. Opens the application, clicks **组织账号登录**, and signs in with that email
   and password.
4. Selects the organization to view its vehicles. An empty fleet is normal before
   vehicles are registered.

In the scripted deployment, invitations go to the private test mailbox instead
of external email. The deployment operator has its URL and credentials in
`mail-credentials.txt`. Other environments use their configured email delivery.
An invitation marked complete means the account was provisioned; the recipient
still needs to finish account setup and log in.

## 3. Register and connect vehicles

As the administrator, repeat these steps for each vehicle:

1. Open **车辆管理** → **添加车辆**.
2. Enter a unique **客户内部车辆编号** and a **车辆名称**, then click **添加车辆**.
3. In **接入与邀请进度**, wait for the vehicle to reach `awaiting_install`.
4. Copy the full generated **车辆 ID**. It is different from the internal number
   entered in step 2.
5. Click **轮换并签发单次安装令牌**, then **下载安装包**.
6. Give the installation package and full vehicle ID to the vehicle operator
   through a protected channel. Each vehicle needs its own package and credentials.

The vehicle operator installs the package, verifies authentication and starts the
vehicle runtime. After installation, check the vehicle's registration status;
after telemetry starts, confirm it appears online in the monitor.

**Apollo setup — TBD:** the container installation command, certificate setup,
runtime configuration and build/start instructions will be documented in
`apollo-base`. Vehicle SDKs are in `data/sdk-kit` and runtime code is in
`modules/teleop`. The enrollment helper currently remains at
[`infra/scripts/install-vehicle-auth.py`](../infra/scripts/install-vehicle-auth.py).

Keep installation packages and device credentials out of Git and chat. Packages
are short-lived and single-use. Installation completion does not by itself mean
the vehicle is online or its cameras are ready.

If invitation/registration controls are unavailable, ask the deployment operator
to check automatic onboarding. If an existing permission change requests
maintenance, follow [authorization management](auth-management.md). Removal,
revocation and credential replacement are covered in [account lifecycle](account-lifecycle.md).
