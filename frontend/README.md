# 运维平台前端

`frontend/` 是运维平台入口。远程接管工作台目前实现企业账号登录和 LiveKit 只读视频监看；车辆控制会话与驾驶指令尚未开放。

## 构建

```bash
npm ci
npm run typecheck
npm run build
```

生产构建输出到 `dist/`。开发预览使用 `npm run dev`。

## 公开运行配置

默认 Gateway、LiveKit、Casdoor 地址和 Casdoor client ID 沿用旧 `apps/operator-console/` 的配置。部署环境可在 `index.html` 加载 `main.js` 之前注入公开配置，例如：

```html
<script>
  window.__LIVEKIT_INFRA_CONFIG__ = {
    gatewayUrl: 'https://gateway.example.com',
    livekitUrl: 'wss://rtc.example.com',
    authorizeUrl: 'https://sso.example.com/login/oauth/authorize',
    tokenUrl: 'https://sso.example.com/api/login/oauth/access_token',
    clientId: 'public-operator-client-id'
  }
</script>
```

这些字段只允许公开端点和 OIDC client ID；不要放置 client secret、LiveKit API secret、设备凭据或访问令牌。Gateway 必须允许平台 origin 的 CORS，Casdoor 必须登记与平台 origin/path 完全匹配的 redirect URI，生产环境使用 HTTPS/WSS。

Access token 只保存在当前页面内存中。刷新页面需要重新登录；浏览器不会恢复之前的车辆连接。

## 本地只读联调

仅查看平台/接管页面布局（不登录、不调用 Gateway/LiveKit）：

```text
http://<前端主机>:8000/?preview=1
```

此预览模式可从车辆列表选择车辆并打开工作台预览，但显示的是占位画面；不会尝试真实接管。

在本机使用 Gateway 的开发认证模式时，可运行前端开发服务器并访问：

```text
http://localhost:8000/?dev=1&backend=http://localhost:8080&livekit=ws://localhost:7880
```

顶栏的“本地开发登录”会提示输入开发令牌，并通过 Gateway `/api/auth/me` 校验。该入口只在 `localhost`、`127.0.0.1` 或 `::1` 且显式带 `dev=1` 时出现；令牌不会写入 URL 或浏览器存储。

接管页建议先选 `car-001`：这是 `docs/local-dev.md` 和车端启动示例中的联调车辆 ID。选择仅是填入 ID，服务端 ACL、车辆是否运行以及视频是否发布仍需分别确认。也可手动输入其他已配置车辆 ID。`AV-*` 车队数据是 UI 演示数据，不应作为实际联调目标。

当前平台工作台为只读监看。原 `apps/operator-console/` 作为独立旧入口保留，其开发控制流程见 `docs/local-dev.md`；执行控制联调仅限隔离的模拟器/测试台，首次验证不得连接真实行驶车辆。
