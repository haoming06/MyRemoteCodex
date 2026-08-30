# FRP 自托管部署

本文说明如何在自己的 Linux 服务器上部署 `FRP v0.71.0`，让手机或其他电脑通过 HTTPS 访问 Mac 上的 My Remote Codex。

## 连接结构

```text
浏览器
  -> HTTPS/WSS
Caddy
  -> 127.0.0.1:8888
frps
  -> TLS 隧道
frpc（Mac）
  -> 127.0.0.1:4310
My Remote Codex
```

Mac 上的网页服务和 CDP 始终只监听回环地址。不要把 Mac 的 `4310`、CDP 的 `9341`、FRP HTTP vhost 端口或 FRP Dashboard 直接开放到公网。

## 准备工作

服务器需要满足以下条件：

- Linux，并使用 systemd；
- 具有公网 IPv4；
- 已安装 Caddy；
- 可以使用 `root` 或 `sudo`；
- 防火墙和云服务器安全组允许所需端口。

需要准备两个指向服务器的域名：

- `frp.example.com`：Mac 上的 `frpc` 连接入口；
- `device-01.remote.example.com`：浏览器访问入口。

没有自有域名时，可以使用 [sslip.io](https://sslip.io/) 生成指向服务器公网 IP 的域名。文档示例中的 `example.com` 和 `11.22.33.44` 均为占位值，部署时需要替换。

默认端口如下：

| 端口 | 用途 | 是否开放公网 |
| --- | --- | --- |
| `80/tcp` | Caddy 申请证书和跳转 HTTPS | 是 |
| `443/tcp` | 浏览器 HTTPS/WSS | 是 |
| `7000/tcp` | `frpc` 连接 `frps` | 是 |
| `8888/tcp` | FRP HTTP vhost | 否，只监听 `127.0.0.1` |

## 在服务器上部署

把项目放到服务器后执行：

```bash
sudo ./scripts/setup-frp.sh server \
  --frp-host frp.example.com \
  --base-domain remote.example.com \
  --device device-01
```

脚本会完成以下操作：

- 下载并校验 `frps v0.71.0`；
- 生成 FRP 服务端私有 CA 和证书；
- 生成相互独立的 FRP token 和网关 token；
- 创建并启动 `my-remote-codex-frps.service`；
- 创建 Caddy 反向代理配置；
- 在 `/root/my-remote-codex-device-01` 生成 Mac 客户端凭据。

脚本不会修改 DNS、云服务器安全组或系统防火墙。它也不会覆盖已有的 `/etc/frp/frps.toml` 或同名客户端凭据目录。

部署完成后检查服务状态：

```bash
sudo ./scripts/setup-frp.sh status
```

默认浏览器入口为：

```text
https://device-01.remote.example.com
```

## 使用非标准 HTTPS 端口

部分网络环境或云服务器可能无法通过公网 `80/443` 提供未备案域名的访问。这种情况下，可以改用 `17777` 等非标准 HTTPS 端口。该端口只是示例，可以替换为云服务器允许使用的其他端口。

编辑脚本生成的 Caddy 配置：

```text
/etc/caddy/conf.d/my-remote-codex-device-01.caddy
```

将站点地址改为带端口的地址：

```caddyfile
device-01.remote.example.com:17777 {
	reverse_proxy 127.0.0.1:8888 {
		header_up X-Remote-Codex-Gateway-Token {$REMOTE_CODEX_GATEWAY_TOKEN}
	}
}
```

然后格式化、校验并重启 Caddy：

```bash
sudo caddy fmt --overwrite /etc/caddy/conf.d/my-remote-codex-device-01.caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl restart caddy
```

还需要完成以下配置：

- 在云服务器安全组和系统防火墙开放 `17777/tcp`；
- 使用 `https://device-01.remote.example.com:17777` 访问；
- 确保 Caddy 已取得该域名的有效证书。

改用 `17777` 不会绕过 HTTPS 证书要求。如果服务器的 `80/443` 都无法用于 ACME 验证，需要通过 DNS Challenge 申请证书，或在 Caddy 中配置已有证书。不要改为公网明文 HTTP。

FRP 的 `7000` 连接端口与浏览器的 `17777` HTTPS 端口相互独立，不需要因为修改浏览器入口而改变 `REMOTE_CODEX_FRP_SERVER_PORT`。

## 把凭据复制到 Mac

在 Mac 上执行：

```bash
scp -r root@frp.example.com:/root/my-remote-codex-device-01 .
```

凭据目录包含：

| 文件 | 用途 |
| --- | --- |
| `metadata.env` | FRP 地址、端口、设备 ID、子域和浏览器访问地址 |
| `frp-token` | `frpc` 连接 `frps` 的认证 token |
| `gateway-token` | Caddy 转发请求时注入的网关 token |
| `frp-ca.crt` | Mac 验证 `frps` 证书的 CA |

不要公开凭据目录。`frp-token` 和 `gateway-token` 必须保持不同，相关文件权限不得高于 `0600`。

## Shell 方式配置 Mac

在 Mac 的项目目录中导入凭据：

```bash
./scripts/setup-frp.sh local --bundle ./my-remote-codex-device-01
```

该命令会：

- 下载并校验 `frpc v0.71.0`；
- 把凭据复制到当前用户的私有配置目录；
- 在项目根目录生成权限为 `0600` 的 `.env.frp`。

启动 Codex 和 FRP：

```bash
./scripts/launch-codex-macos.sh
./scripts/setup-frp.sh start
```

查看本机 FRP 配置：

```bash
./scripts/setup-frp.sh status
```

如果浏览器入口使用非标准端口，访问时直接使用带端口的 URL。`.env.frp` 只保存 `frpc` 连接参数，不需要加入浏览器 HTTPS 端口。

## macOS 安装版配置

打开 `My Remote Codex.app` 的“FRP”页并开启“FRP 自托管隧道”，然后根据 `metadata.env` 和凭据文件填写：

| 界面字段 | 填写内容 |
| --- | --- |
| FRP 地址 | `FRP_SERVER_ADDR` |
| 端口 | `FRP_SERVER_PORT` |
| 证书名称 | `FRP_SERVER_NAME` |
| CA 证书 | 选择 `frp-ca.crt` |
| 设备 ID | `FRP_CLIENT_ID` |
| 用户 | `FRP_USER` |
| 子域 | `FRP_SUBDOMAIN` |
| FRP token | `frp-token` 的内容 |
| 网关 token | `gateway-token` 的内容 |

保持 TLS 验证为“验证服务器”。安装包已经内置 `frpc`，其路径可以留空。保存配置后点击“启动服务”，再使用“测试连接”检查本机服务、Codex CDP 和 FRP 隧道。公网入口请直接使用 `metadata.env` 中的 `PUBLIC_URL` 在浏览器验证。

## 手工配置参考

脚本生成的 `frps.toml` 主要配置如下：

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
vhostHTTPPort = 8888
subDomainHost = "remote.example.com"

transport.tls.force = true
transport.tls.certFile = "/etc/frp/tls/server.crt"
transport.tls.keyFile = "/etc/frp/tls/server.key"

auth.method = "token"
auth.additionalScopes = ["HeartBeats", "NewWorkConns"]
auth.tokenSource.type = "file"
auth.tokenSource.file.path = "/etc/frp/secrets/frp-token"

maxPortsPerClient = 1
```

Caddy 必须把浏览器请求转发到本机 FRP vhost，并覆盖客户端提交的网关 token 请求头：

```caddyfile
device-01.remote.example.com {
	reverse_proxy 127.0.0.1:8888 {
		header_up X-Remote-Codex-Gateway-Token {$REMOTE_CODEX_GATEWAY_TOKEN}
	}
}
```

Caddy 环境中的 `REMOTE_CODEX_GATEWAY_TOKEN` 必须与 Mac 上 `gateway-token` 的内容完全一致。

## WebRTC 和 TURN

FRP 负责转发网页、输入协议、WebSocket 和 WebRTC 信令，但不会自动转发 WebRTC 的 UDP 媒体。Mac 与浏览器无法直接建立 ICE 通道时，可以配置 TURN：

```bash
REMOTE_CODEX_WEBRTC_ICE_SERVERS='[{"urls":"turns:turn.example.com:5349","username":"device","credential":"short-lived-secret"}]'
```

TURN 凭据应使用短期凭据，不要把长期管理密钥提供给浏览器。未配置 TURN 或 WebRTC 建连失败时，客户端会自动回退到经 FRP/WSS 传输的 JPEG。

## 部署验证

完成部署后逐项检查：

1. Mac 上的 `4310` 和 `9341` 只监听 `127.0.0.1`。
2. 服务器上的 `8888` 只监听 `127.0.0.1`。
3. `frps` 和 Caddy 服务均为运行状态。
4. 浏览器只能通过 HTTPS 地址访问，并能正常升级 WSS。
5. 浏览器输入配对码后可以查看画面并发送操作。
6. FRP token 与网关 token 不相同，文件权限不高于 `0600`。
7. `frpc` 会校验 `frps` 的证书 CA 和服务端名称。

## 常见问题

### Caddy 无法申请证书

确认域名已经解析到服务器，并检查 ACME 验证所需的 `80/443` 是否可达。使用非标准 HTTPS 端口且无法开放 `80/443` 时，改用 DNS Challenge 或手工配置证书。

### 公网地址返回 502

依次检查 `my-remote-codex-frps.service`、Mac 上的 `frpc` 和 My Remote Codex 是否正在运行，并确认 Caddy 的上游端口与 `vhostHTTPPort` 相同。

### 公网地址返回 401 或 403

确认服务器 Caddy 环境中的 `REMOTE_CODEX_GATEWAY_TOKEN` 与 Mac 上 `gateway-token` 的内容完全一致，然后重启 Caddy 和 My Remote Codex。

### FRP 隧道启动失败

确认 `frpc` 与 `frps` 都是 `v0.71.0`，检查 `FRP_SERVER_ADDR`、`FRP_SERVER_PORT`、CA 证书和证书名称，并查看服务端与 Mac 的运行日志。

## 安全检查

- 不要把 Mac 的 `4310` 或 `9341` 暴露到局域网或公网。
- 不要把服务器的 `8888` 或 FRP Dashboard 暴露到公网。
- 不要使用公网明文 HTTP；浏览器入口必须使用 HTTPS/WSS。
- 不要关闭 `frpc` 对 `frps` 的证书验证。
- 不要复用 FRP token 和网关 token。
- 不要把凭据目录、`.env.frp`、token 或私钥提交到 Git。

FRP 字段和行为可参考 [v0.71.0 完整客户端配置](https://github.com/fatedier/frp/blob/v0.71.0/conf/frpc_full_example.toml)、[v0.71.0 完整服务端配置](https://github.com/fatedier/frp/blob/v0.71.0/conf/frps_full_example.toml) 和 [v0.71.0 Release](https://github.com/fatedier/frp/releases/tag/v0.71.0)。
