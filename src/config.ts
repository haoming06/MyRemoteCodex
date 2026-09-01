import path from "node:path";
import { isIP } from "node:net";

export interface FrpConfig {
  binary: string;
  serverAddr: string;
  serverPort: number;
  clientId: string;
  user: string;
  subdomain: string;
  tokenFile: string;
  gatewayTokenFile: string;
  verifyServerCertificate: boolean;
  trustedCaFile?: string;
  serverName?: string;
  clientCertFile?: string;
  clientKeyFile?: string;
}

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function booleanFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (!raw) return fallback;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export interface AppConfig {
  host: string;
  port: number;
  cdpPort: number;
  jpegQuality: number;
  maxFrameWidth: number;
  maxFrameHeight: number;
  normalMaxFps: number;
  highJpegQuality: number;
  highMaxFrameWidth: number;
  highMaxFrameHeight: number;
  highMaxFps: number;
  backgroundCaptureDelayMs: number;
  backgroundCaptureIntervalMs: number;
  pairingCode?: string;
  sessionTtlMs: number;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  publicOrigin?: string;
  secureCookies: boolean;
  staticRoot: string;
  videoTransport: "auto" | "jpeg";
  nativeCaptureBinary: string;
  nativeCaptureBundleId: string;
  videoNormalFps: number;
  videoNormalMaxWidth: number;
  videoNormalBitrate: number;
  videoHighFps: number;
  videoHighMaxWidth: number;
  videoHighBitrate: number;
  webRtcIceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }>;
  frp?: FrpConfig;
}

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when REMOTE_CODEX_FRP_ENABLED is true`);
  return value;
}

function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)) {
    throw new Error(`${name} must be 1-64 ASCII letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function subdomain(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("REMOTE_CODEX_FRP_SUBDOMAIN must be a lowercase DNS label");
  }
  return value;
}

function hostname(value: string, name: string): string {
  const validDnsName = value.length <= 253 && value.split(".").every((label) => (
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  ));
  if (!isIP(value) && !validDnsName) {
    throw new Error(`${name} must be a hostname or IP address without a URL scheme or path`);
  }
  return value;
}

function commandPath(value: string): string {
  return value.includes(path.sep) ? path.resolve(value) : value;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "::1", "localhost"].includes(host.toLowerCase());
}

function publicOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.REMOTE_CODEX_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("REMOTE_CODEX_PUBLIC_ORIGIN must be a valid HTTPS origin");
  }
  if (
    parsed.protocol !== "https:"
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("REMOTE_CODEX_PUBLIC_ORIGIN must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function videoTransport(env: NodeJS.ProcessEnv): "auto" | "jpeg" {
  const value = env.REMOTE_CODEX_VIDEO_TRANSPORT?.trim() || "auto";
  if (value !== "auto" && value !== "jpeg") {
    throw new Error("REMOTE_CODEX_VIDEO_TRANSPORT must be auto or jpeg");
  }
  return value;
}

function webRtcIceServers(env: NodeJS.ProcessEnv): AppConfig["webRtcIceServers"] {
  const raw = env.REMOTE_CODEX_WEBRTC_ICE_SERVERS?.trim();
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("REMOTE_CODEX_WEBRTC_ICE_SERVERS must be valid JSON");
  }
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error("REMOTE_CODEX_WEBRTC_ICE_SERVERS must be an array with at most 8 entries");
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("WebRTC ICE server entry must be an object");
    const server = entry as Record<string, unknown>;
    const urls = typeof server.urls === "string"
      ? [server.urls]
      : Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string")
        ? server.urls
        : undefined;
    if (!urls?.length || urls.some((url) => !/^(stun|turn|turns):/i.test(url))) {
      throw new Error("WebRTC ICE server URLs must use stun:, turn:, or turns:");
    }
    if (
      (server.username !== undefined && typeof server.username !== "string")
      || (server.credential !== undefined && typeof server.credential !== "string")
    ) throw new Error("WebRTC ICE username and credential must be strings");
    return {
      urls: typeof server.urls === "string" ? server.urls : urls,
      username: server.username as string | undefined,
      credential: server.credential as string | undefined,
    };
  });
}

function filePath(env: NodeJS.ProcessEnv, name: string): string {
  return path.resolve(requiredEnv(env, name));
}

function loadFrpConfig(env: NodeJS.ProcessEnv, host: string): FrpConfig | undefined {
  if (!booleanFromEnv(env, "REMOTE_CODEX_FRP_ENABLED", false)) return undefined;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("REMOTE_CODEX_HOST must be a loopback address when FRP is enabled");
  }

  const clientCert = env.REMOTE_CODEX_FRP_CLIENT_CERT?.trim();
  const clientKey = env.REMOTE_CODEX_FRP_CLIENT_KEY?.trim();
  if (Boolean(clientCert) !== Boolean(clientKey)) {
    throw new Error("REMOTE_CODEX_FRP_CLIENT_CERT and REMOTE_CODEX_FRP_CLIENT_KEY must be set together");
  }
  const verifyServerCertificate = booleanFromEnv(env, "REMOTE_CODEX_FRP_VERIFY_SERVER", true);

  return {
    binary: commandPath(env.REMOTE_CODEX_FRP_BINARY?.trim() || "frpc"),
    serverAddr: hostname(requiredEnv(env, "REMOTE_CODEX_FRP_SERVER_ADDR"), "REMOTE_CODEX_FRP_SERVER_ADDR"),
    serverPort: integerFromEnv(env, "REMOTE_CODEX_FRP_SERVER_PORT", 7000, 1, 65535),
    clientId: identifier(requiredEnv(env, "REMOTE_CODEX_FRP_CLIENT_ID"), "REMOTE_CODEX_FRP_CLIENT_ID"),
    user: identifier(requiredEnv(env, "REMOTE_CODEX_FRP_USER"), "REMOTE_CODEX_FRP_USER"),
    subdomain: subdomain(requiredEnv(env, "REMOTE_CODEX_FRP_SUBDOMAIN")),
    tokenFile: filePath(env, "REMOTE_CODEX_FRP_TOKEN_FILE"),
    gatewayTokenFile: filePath(env, "REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE"),
    verifyServerCertificate,
    trustedCaFile: verifyServerCertificate ? filePath(env, "REMOTE_CODEX_FRP_TRUSTED_CA") : undefined,
    serverName: verifyServerCertificate
      ? hostname(requiredEnv(env, "REMOTE_CODEX_FRP_SERVER_NAME"), "REMOTE_CODEX_FRP_SERVER_NAME")
      : undefined,
    clientCertFile: clientCert ? path.resolve(clientCert) : undefined,
    clientKeyFile: clientKey ? path.resolve(clientKey) : undefined,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tlsCertPath = env.REMOTE_CODEX_TLS_CERT
    ? path.resolve(env.REMOTE_CODEX_TLS_CERT)
    : undefined;
  const tlsKeyPath = env.REMOTE_CODEX_TLS_KEY
    ? path.resolve(env.REMOTE_CODEX_TLS_KEY)
    : undefined;

  if (Boolean(tlsCertPath) !== Boolean(tlsKeyPath)) {
    throw new Error("REMOTE_CODEX_TLS_CERT and REMOTE_CODEX_TLS_KEY must be set together");
  }

  const host = env.REMOTE_CODEX_HOST || "127.0.0.1";
  const frp = loadFrpConfig(env, host);
  const configuredPublicOrigin = publicOrigin(env);
  if (configuredPublicOrigin && !isLoopbackHost(host)) {
    throw new Error("REMOTE_CODEX_HOST must be a loopback address when REMOTE_CODEX_PUBLIC_ORIGIN is set");
  }
  const allowInsecureHttp = booleanFromEnv(env, "REMOTE_CODEX_ALLOW_INSECURE_HTTP", false);
  if (!isLoopbackHost(host) && !tlsCertPath && !frp && !allowInsecureHttp) {
    throw new Error(
      "Non-loopback HTTP is disabled; configure REMOTE_CODEX_TLS_CERT and REMOTE_CODEX_TLS_KEY, "
      + "or explicitly set REMOTE_CODEX_ALLOW_INSECURE_HTTP=true for a trusted LAN",
    );
  }
  const securePublicAccess = Boolean(tlsCertPath || frp || configuredPublicOrigin);
  const secureCookies = booleanFromEnv(env, "REMOTE_CODEX_SECURE_COOKIE", securePublicAccess);
  if (securePublicAccess && !secureCookies) {
    throw new Error(
      "REMOTE_CODEX_SECURE_COOKIE cannot be disabled when HTTPS or FRP is enabled, "
      + "or when a public origin is configured",
    );
  }

  return {
    host,
    port: integerFromEnv(env, "REMOTE_CODEX_PORT", 4310, 1024, 65535),
    cdpPort: integerFromEnv(env, "REMOTE_CODEX_CDP_PORT", 9341, 1024, 65535),
    jpegQuality: integerFromEnv(env, "REMOTE_CODEX_JPEG_QUALITY", 82, 30, 100),
    maxFrameWidth: integerFromEnv(env, "REMOTE_CODEX_MAX_FRAME_WIDTH", 1600, 320, 4096),
    maxFrameHeight: integerFromEnv(env, "REMOTE_CODEX_MAX_FRAME_HEIGHT", 1200, 240, 4096),
    normalMaxFps: integerFromEnv(env, "REMOTE_CODEX_NORMAL_MAX_FPS", 20, 5, 60),
    highJpegQuality: integerFromEnv(env, "REMOTE_CODEX_HIGH_JPEG_QUALITY", 92, 30, 100),
    highMaxFrameWidth: integerFromEnv(env, "REMOTE_CODEX_HIGH_MAX_FRAME_WIDTH", 4096, 320, 4096),
    highMaxFrameHeight: integerFromEnv(env, "REMOTE_CODEX_HIGH_MAX_FRAME_HEIGHT", 4096, 240, 4096),
    highMaxFps: integerFromEnv(env, "REMOTE_CODEX_HIGH_MAX_FPS", 30, 5, 60),
    backgroundCaptureDelayMs: integerFromEnv(env, "REMOTE_CODEX_BACKGROUND_CAPTURE_DELAY_MS", 1500, 500, 30000),
    backgroundCaptureIntervalMs: integerFromEnv(env, "REMOTE_CODEX_BACKGROUND_CAPTURE_INTERVAL_MS", 1000, 250, 10000),
    pairingCode: env.REMOTE_CODEX_PAIRING_CODE,
    sessionTtlMs: integerFromEnv(env, "REMOTE_CODEX_SESSION_HOURS", 12, 1, 168) * 60 * 60 * 1000,
    tlsCertPath,
    tlsKeyPath,
    publicOrigin: configuredPublicOrigin,
    secureCookies,
    staticRoot: path.resolve(process.cwd(), "dist/client"),
    videoTransport: videoTransport(env),
    nativeCaptureBinary: path.resolve(
      env.REMOTE_CODEX_NATIVE_CAPTURE_BINARY
        || "native/macos-capture/.build/My Remote Codex Capture.app/Contents/MacOS/remote-codex-capture",
    ),
    nativeCaptureBundleId: env.REMOTE_CODEX_NATIVE_CAPTURE_BUNDLE_ID?.trim() || "com.openai.codex",
    videoNormalFps: integerFromEnv(env, "REMOTE_CODEX_VIDEO_NORMAL_FPS", 30, 10, 60),
    videoNormalMaxWidth: integerFromEnv(env, "REMOTE_CODEX_VIDEO_NORMAL_MAX_WIDTH", 1600, 640, 4096),
    videoNormalBitrate: integerFromEnv(env, "REMOTE_CODEX_VIDEO_NORMAL_BITRATE", 3_000_000, 500_000, 30_000_000),
    videoHighFps: integerFromEnv(env, "REMOTE_CODEX_VIDEO_HIGH_FPS", 45, 10, 60),
    videoHighMaxWidth: integerFromEnv(env, "REMOTE_CODEX_VIDEO_HIGH_MAX_WIDTH", 2560, 640, 4096),
    videoHighBitrate: integerFromEnv(env, "REMOTE_CODEX_VIDEO_HIGH_BITRATE", 7_000_000, 500_000, 30_000_000),
    webRtcIceServers: webRtcIceServers(env),
    frp,
  };
}
