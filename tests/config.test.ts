import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

function frpEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    REMOTE_CODEX_FRP_ENABLED: "true",
    REMOTE_CODEX_FRP_SERVER_ADDR: "frp.example.com",
    REMOTE_CODEX_FRP_CLIENT_ID: "device_01",
    REMOTE_CODEX_FRP_USER: "account_01",
    REMOTE_CODEX_FRP_SUBDOMAIN: "device-01",
    REMOTE_CODEX_FRP_TOKEN_FILE: "secrets/frp-token",
    REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE: "secrets/gateway-token",
    REMOTE_CODEX_FRP_TRUSTED_CA: "certs/ca.pem",
    REMOTE_CODEX_FRP_SERVER_NAME: "frp.example.com",
    ...overrides,
  };
}

describe("FRP configuration", () => {
  it("keeps FRP disabled by default", () => {
    const config = loadConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.normalMaxFps).toBe(20);
    expect(config.highMaxFps).toBe(30);
    expect(config.videoTransport).toBe("auto");
    expect(config.videoNormalFps).toBe(30);
    expect(config.videoHighFps).toBe(45);
    expect(config.webRtcIceServers).toEqual([]);
    expect(config.nativeCaptureBinary).toContain("My Remote Codex Capture.app/Contents/MacOS/remote-codex-capture");
    expect(config.frp).toBeUndefined();
  });

  it("loads and validates WebRTC ICE servers", () => {
    const config = loadConfig({
      REMOTE_CODEX_WEBRTC_ICE_SERVERS: JSON.stringify([
        { urls: "stun:stun.example.com:3478" },
        { urls: ["turns:turn.example.com:5349"], username: "device", credential: "secret" },
      ]),
    });
    expect(config.webRtcIceServers).toHaveLength(2);
    expect(() => loadConfig({ REMOTE_CODEX_WEBRTC_ICE_SERVERS: '[{"urls":"https://bad"}]' }))
      .toThrow("must use stun:, turn:, or turns:");
    expect(() => loadConfig({ REMOTE_CODEX_VIDEO_TRANSPORT: "h264" }))
      .toThrow("must be auto or jpeg");
  });

  it("validates stream frame-rate limits", () => {
    expect(loadConfig({ REMOTE_CODEX_NORMAL_MAX_FPS: "15" }).normalMaxFps).toBe(15);
    expect(() => loadConfig({ REMOTE_CODEX_HIGH_MAX_FPS: "61" }))
      .toThrow("REMOTE_CODEX_HIGH_MAX_FPS must be an integer between 5 and 60");
  });

  it("fails closed when plain HTTP is exposed beyond loopback", () => {
    expect(() => loadConfig({ REMOTE_CODEX_HOST: "0.0.0.0" }))
      .toThrow("Non-loopback HTTP is disabled");

    expect(loadConfig({
      REMOTE_CODEX_HOST: "0.0.0.0",
      REMOTE_CODEX_ALLOW_INSECURE_HTTP: "true",
    }).host).toBe("0.0.0.0");

    expect(loadConfig({
      REMOTE_CODEX_HOST: "0.0.0.0",
      REMOTE_CODEX_TLS_CERT: "certs/server.crt",
      REMOTE_CODEX_TLS_KEY: "certs/server.key",
    }).secureCookies).toBe(true);
  });

  it("does not allow insecure cookies with direct TLS", () => {
    expect(() => loadConfig({
      REMOTE_CODEX_TLS_CERT: "certs/server.crt",
      REMOTE_CODEX_TLS_KEY: "certs/server.key",
      REMOTE_CODEX_SECURE_COOKIE: "false",
    })).toThrow("cannot be disabled when HTTPS or FRP is enabled");
  });

  it("accepts one explicit HTTPS origin for an external tunnel", () => {
    const config = loadConfig({
      REMOTE_CODEX_PUBLIC_ORIGIN: "https://device.example-tunnel.com:8443/",
    });
    expect(config.publicOrigin).toBe("https://device.example-tunnel.com:8443");
    expect(config.secureCookies).toBe(true);

    expect(() => loadConfig({
      REMOTE_CODEX_PUBLIC_ORIGIN: "http://device.example-tunnel.com",
    })).toThrow("must be an HTTPS origin");
    expect(() => loadConfig({
      REMOTE_CODEX_PUBLIC_ORIGIN: "https://device.example-tunnel.com/control",
    })).toThrow("without credentials, path, query, or fragment");
  });

  it("keeps an external HTTPS tunnel on loopback with secure cookies", () => {
    expect(() => loadConfig({
      REMOTE_CODEX_HOST: "0.0.0.0",
      REMOTE_CODEX_PUBLIC_ORIGIN: "https://device.example-tunnel.com",
    })).toThrow("must be a loopback address");
    expect(() => loadConfig({
      REMOTE_CODEX_PUBLIC_ORIGIN: "https://device.example-tunnel.com",
      REMOTE_CODEX_SECURE_COOKIE: "false",
    })).toThrow("cannot be disabled");
  });

  it("loads the restricted FRP settings and forces secure cookies", () => {
    const config = loadConfig(frpEnv());
    expect(config.secureCookies).toBe(true);
    expect(config.frp).toMatchObject({
      binary: "frpc",
      serverAddr: "frp.example.com",
      serverPort: 7000,
      clientId: "device_01",
      user: "account_01",
      subdomain: "device-01",
      tokenFile: path.resolve("secrets/frp-token"),
      gatewayTokenFile: path.resolve("secrets/gateway-token"),
      verifyServerCertificate: true,
      trustedCaFile: path.resolve("certs/ca.pem"),
      serverName: "frp.example.com",
    });
  });

  it("allows explicit encrypted compatibility mode without server verification", () => {
    const config = loadConfig(frpEnv({
      REMOTE_CODEX_FRP_VERIFY_SERVER: "false",
      REMOTE_CODEX_FRP_TRUSTED_CA: undefined,
      REMOTE_CODEX_FRP_SERVER_NAME: undefined,
    }));
    expect(config.frp).toMatchObject({ verifyServerCertificate: false });
    expect(config.frp?.trustedCaFile).toBeUndefined();
    expect(config.frp?.serverName).toBeUndefined();
  });

  it("keeps server verification enabled by default", () => {
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_FRP_TRUSTED_CA: undefined })))
      .toThrow("REMOTE_CODEX_FRP_TRUSTED_CA is required");
  });

  it("rejects binding the local gateway to a network interface", () => {
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_HOST: "0.0.0.0" })))
      .toThrow("must be a loopback address");
  });

  it("rejects unsafe routing identifiers", () => {
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_FRP_SUBDOMAIN: "Other/User" })))
      .toThrow("lowercase DNS label");
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_FRP_USER: "tenant/../../other" })))
      .toThrow("must be 1-64 ASCII");
  });

  it("requires mTLS client files as a pair", () => {
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_FRP_CLIENT_CERT: "certs/client.pem" })))
      .toThrow("CLIENT_CERT and REMOTE_CODEX_FRP_CLIENT_KEY must be set together");
  });

  it("does not allow insecure cookies through a public tunnel", () => {
    expect(() => loadConfig(frpEnv({ REMOTE_CODEX_SECURE_COOKIE: "false" })))
      .toThrow("cannot be disabled when HTTPS or FRP is enabled");
  });
});
