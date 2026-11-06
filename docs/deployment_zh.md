# 部署

在部署主机上从仓库根目录运行命令。每个环境使用相同的工作流，但各自使用自己的地址、Compose 项目和状态目录。车辆构建和服务属于 `apollo-base`。

## 要求

- 运行 Docker Engine 和 Compose v2、Python 3.8+、Node.js 22 和 npm 的 Linux 服务器。
- 一个稳定的 IPv4 地址或 DNS 名称，可从浏览器、车辆和容器访问。
- 三个可用的 HTTPS 端口；默认是 8443–8445。
- 一个位于 Git 检出目录之外的可写状态目录。脚本会以 0700 模式创建它，并在其中存储配置、凭据和证书。

构建使用标准 Docker 注册表和 Go 模块代理。如果你的网络需要，请在主机环境中配置 Docker 注册表镜像和 `GOPROXY`。

此工作流会创建一个 Gateway、前端、Casdoor、PostgreSQL、Redis、LiveKit、Caddy 和一个私有测试邮箱。它使用托管授权和私有 CA。邀请会留在测试邮箱中；驾驶功能被禁用。对于公共证书、外部电子邮件或单独的静态前端，请使用[云参考](deployment-cloud.md)。

## 首次部署

检出目标修订版本，然后运行：

```bash
python3 infra/scripts/deploy.py --state ../teleop-state \
  --host SERVER_IP_OR_DNS --project teleop --base-port 8443 up
```

将 `SERVER_IP_OR_DNS` 替换为你的服务器地址。该命令会创建受保护的配置、构建两个应用镜像、启动服务、初始化管理员，并验证 TLS、所提供的前端资源、健康/就绪状态以及一次真实的 PKCE 登录。主机、项目和端口设置会被保存；后续命令只需要 `--state`。

| 端点 | 默认 URL |
| --- | --- |
| 应用和管理 | `https://HOST:8443/` 和 `https://HOST:8443/#/admin` |
| 登录 | `https://HOST:8444/` |
| 测试邮箱 | `https://HOST:8445/` |

在服务器上的状态目录中读取 `administrator.txt` 和 `mail-credentials.txt`。只将其公共 `root.crt` 复制到客户端，与服务器操作员验证其指纹，并在每个浏览器/车辆信任库中信任它。对于 Ubuntu 客户端，辅助脚本可通过一条命令安装并验证它：

```bash
bash infra/scripts/trust-authentication-ca.sh --ca /path/to/root.crt \
  --fingerprint EXPECTED_SHA256 --url https://HOST:8443/readyz
```

要启用摄像头媒体，请在首次部署命令中添加 `--media-port 9781`，并允许该端口通过 TCP 和 UDP。如果使用 DNS 主机，还需传入 `--media-ip REACHABLE_SERVER_IPV4`。`--bind-address LOCAL_IPV4` 选择一个本地接口；其默认值是主机 IP，对于 DNS 主机则是所有 IPv4 接口。媒体客户端必须能够访问所公布的 IP/端口；NAT 需要匹配的端口转发。RTC 信令仍位于 Gateway 之后。开放媒体端口不会启用驾驶功能。

## 更新

将检出更新到目标修订版本，然后运行：

```bash
python3 infra/scripts/deploy.py --state ../teleop-state update
```

这会构建镜像，仅重新创建 Gateway/前端并验证结果。它会保留已保存的配置、证书、凭据、维护模式、媒体设置和数据库卷。构建失败不会重启服务；验证失败会以非零状态退出——在将更新视为成功之前请检查日志。该脚本不会拉取 Git 或覆盖本地源代码更改。

对于现有部署，将 `--state` 指向其现有目录；支持已保存的 `deployment.json` 设置。不要为同一个 Compose 项目初始化第二个状态目录。更改主机或 HTTPS 端口会更改签发者，并且需要单独的环境或有意的身份迁移。

## 日常命令

```bash
python3 infra/scripts/deploy.py --state ../teleop-state status
python3 infra/scripts/deploy.py --state ../teleop-state verify
python3 infra/scripts/deploy.py --state ../teleop-state logs
python3 infra/scripts/deploy.py --state ../teleop-state stop
python3 infra/scripts/deploy.py --state ../teleop-state up
```

`stop` 会保留状态和卷；`up` 会重新构建并启动已保存的环境。对于长时间远程构建，请使用 tmux 等持久终端。在更新期间绝不要删除状态或运行 `docker compose down -v`。升级前请将受保护状态和持久数据库一起备份。

现有访问权限变更使用 `maintenance-on` / `maintenance-off`，并带有相同的脚本和状态参数。遵循[维护/排空流程](auth-management.md)；重启不会绕过其等待期。部署后使用[用户与车辆接入指南](onboarding.md)。

`prepare` 是显式的配置重新生成操作。仅在更改生成的设置时使用它，例如 `--media-port 9781 prepare`，然后使用 `start` 应用，使用 `verify` 检查。它可以替换对生成文件的手动编辑；常规 `update` 绝不会调用它。之前的 `authentication-test.py` 入口点和 `all` 操作仍然受支持。

## 车辆部署

车辆 SDK 位于 `apollo-base/data/sdk-kit`；遥测、媒体和控制位于 `apollo-base/modules/teleop`。遵循该检出目录的构建和部署指南。此仓库提供云服务和 `infra/scripts/install-vehicle-auth.py` 用于受保护注册。仅安装不会启动车辆遥测。

在 Apollo 开发环境内，运行其 SDK 和模块检查：

```bash
bazel test --lockfile_mode=off @sdk_kit//tests/... //modules/teleop/... \
  //modules/guardian/... //modules/canbus:canbus_test --test_output=errors
```

在车辆 SDK 中的初始和刷新 OAuth 请求中保留 `teleop:vehicle`。云健康检查不会验证摄像头发布或物理控制。

## 可选的托管授权试点

对于现有的公有域名 Compose 栈，请使用[托管授权叠加层](deployment-cloud.md#optional-managed-authorization-pilot)。

## 客户端部署

公共运行时配置和独立前端托管记录在[云参考](deployment-cloud.md#client-deployment)中。

## Cloudflare Pages 与单一后端主机

有关 DNS、入口、缓存和跨源配置，请参阅[独立静态托管](deployment-cloud.md#cloudflare-pages-and-a-single-backend-host)。
