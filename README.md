# My Remote Codex

**English** | [简体中文](README.zh-CN.md)

View and control Codex running on your Mac from a phone or another computer. Monitor progress and send follow-up instructions from any browser—no OpenAI account or ChatGPT mobile app is required on the remote device.

[Watch the demo](#demo) · [Quick Start](#quick-start)

## Demo

![My Remote Codex demo](assets/readme/demo.gif)

## Quick Start

My Remote Codex requires macOS and the official Codex desktop app. The DMG is recommended for most users; use the Shell setup only for development or running from source.

### Install with DMG (recommended)

1. Open the DMG, drag `My Remote Codex.app` into Applications, and launch it.
2. If macOS blocks the first launch, open System Settings → Privacy & Security, find the notice for `My Remote Codex.app`, click Open Anyway, and confirm once more.
3. Enable **Allow trusted devices on the local network**.
4. Click **Start service** to see the access URL and pairing code.
5. Open the URL in a browser on your phone or another computer, then enter the pairing code.

If you already have an FRP TOML file from a service provider, open the **FRP** page, choose **External TOML**, select the configuration file, and enter the final public HTTPS URL.

The DMG bundles the runtime and `frpc`; you do not need to install Node.js or run any Shell scripts from this repository.

### Run from source

This setup is intended for development and requires Node.js 22 or later. Run the following commands once:

```bash
npm install
npm run build:native:macos
npm run build
```

Quit Codex normally, then start Codex and the web service:

```bash
./scripts/launch-codex-macos.sh
REMOTE_CODEX_ALLOW_INSECURE_HTTP=true REMOTE_CODEX_HOST=0.0.0.0 npm start
```

Open the URL shown in the terminal on another device and enter the pairing code.

> Plain HTTP on a local network is suitable only for a fully trusted, isolated network. CDP must listen on the local loopback interface only—never expose port `9341` to a LAN or the public internet.

## Key Features

- Displays the real Codex interface in the browser instead of maintaining a replica.
- Supports mouse, touch, keyboard input, and follow-up instructions while a task is running.
- Uses low-latency H.264/WebRTC streaming on macOS when available, with automatic JPEG fallback.
- Protects access with pairing codes, session authentication, and input rate limiting.
- Supports trusted local networks, provider-managed FRP TOML tunnels, and authenticated self-hosted access with `FRP v0.71.0`.

## Public Access with FRP

FRP is only required when connecting across networks. The DMG supports two modes:

- **External TOML:** use a standard `frpc` TOML file supplied by a tunnel provider. The proxy must target `127.0.0.1` on port `4310` (or your configured web port) and must never expose CDP port `9341`.
- **Self-hosted:** deploy `frps v0.71.0`, TLS, systemd, and Caddy on a Linux server, then import the generated credentials in the app.

For complete provider and self-hosted setup instructions, see the [Chinese README](README.zh-CN.md#frp-公网访问) and [FRP self-hosting guide](docs/frp-self-hosting.md).

## Documentation

- [User guide: usage, configuration, troubleshooting, security boundaries, and device testing (Chinese)](docs/user-guide.md)
- [Self-hosting FRP: server, Mac, non-standard HTTPS ports, and troubleshooting (Chinese)](docs/frp-self-hosting.md)
- [macOS installer: configuration app, DMG, signing, and notarization (Chinese)](docs/macos-installer.md)

## About

This project uses the Chrome DevTools Protocol to capture the real Codex interface and forward restricted input events. It is an experimental open-source tool, not an official OpenAI plugin, and may require updates when Codex changes.

## License

This project is available under the [MIT License](LICENSE).
