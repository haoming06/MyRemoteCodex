import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { PairingManager, parseCookies, sessionCookie, SESSION_COOKIE } from "./auth.js";
import { loadConfig } from "./config.js";
import { ControlLease } from "./control-lease.js";
import { CdpMirror, type MirrorFrame, type MirrorState } from "./cdp/mirror.js";
import { GatewayAccess } from "./frp/gateway-auth.js";
import { createTunnelRunner } from "./frp/tunnel.js";
import { encodeFramePacket, LatestFrameBroadcaster } from "./frame-transport.js";
import { RemoteInputScheduler } from "./input-scheduler.js";
import { MacOSNativeCapture } from "./video/native-capture.js";
import { WebRtcVideoService } from "./video/webrtc.js";
import {
  finiteNumber,
  parseClientMessage,
  validModifiers,
  type ClientMessage,
} from "./protocol.js";

const config = loadConfig();
const selfHostedFrp = config.tunnel?.kind === "self-hosted" ? config.tunnel : undefined;
const gatewayAccess = selfHostedFrp
  ? await GatewayAccess.fromFile(selfHostedFrp.gatewayTokenFile)
  : undefined;
const frpTunnel = config.tunnel
  ? createTunnelRunner(config.tunnel, config.port, [config.cdpPort])
  : undefined;
const auth = new PairingManager({
  code: config.pairingCode,
  sessionTtlMs: config.sessionTtlMs,
});
const publicProtocol = config.tlsCertPath || selfHostedFrp ? "https:" : "http:";
const usesSecurePublicAccess = publicProtocol === "https:" || config.publicOrigin !== undefined;
const sessionSockets = new Map<string, Set<WebSocket>>();
const mirror = new CdpMirror({
  cdpPort: config.cdpPort,
  jpegQuality: config.jpegQuality,
  maxFrameWidth: config.maxFrameWidth,
  maxFrameHeight: config.maxFrameHeight,
  normalMaxFps: config.normalMaxFps,
  highJpegQuality: config.highJpegQuality,
  highMaxFrameWidth: config.highMaxFrameWidth,
  highMaxFrameHeight: config.highMaxFrameHeight,
  highMaxFps: config.highMaxFps,
  backgroundCaptureDelayMs: config.backgroundCaptureDelayMs,
  backgroundCaptureIntervalMs: config.backgroundCaptureIntervalMs,
});

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(usesSecurePublicAccess ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 4_096) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function sessionIdFor(request: IncomingMessage): string | undefined {
  return parseCookies(request.headers.cookie).get(SESSION_COOKIE);
}

function isAuthenticated(request: IncomingMessage): boolean {
  return auth.validate(sessionIdFor(request));
}

function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const loopbackHttp = parsed.protocol === "http:"
      && ["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)
      && ["127.0.0.1", "::1"].includes(request.socket.remoteAddress || "");
    const validShape = !parsed.username
      && !parsed.password
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
    const configuredPublicOrigin = config.publicOrigin !== undefined
      && parsed.origin === config.publicOrigin;
    const requestOrigin = (parsed.protocol === publicProtocol || loopbackHttp)
      && parsed.host.toLowerCase() === host.toLowerCase();
    return validShape && (configuredPublicOrigin || requestOrigin);
  } catch {
    return false;
  }
}

function closeSessionSockets(sessionId: string | undefined, reason: string): void {
  if (!sessionId) return;
  for (const socket of sessionSockets.get(sessionId) || []) {
    socket.close(1008, reason);
  }
}

async function routeApi(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === "/api/pair" && request.method === "POST") {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: "请求来源无效" });
      return true;
    }
    try {
      const body = await readJsonBody(request);
      const code = typeof body.code === "string" ? body.code : "";
      const result = auth.pair(request.socket.remoteAddress || "unknown", code);
      if (!result.ok) {
        sendJson(response, result.status, {
          error: result.status === 429 ? "尝试次数过多，请稍后再试" : "配对码不正确",
        });
        return true;
      }
      response.setHeader(
        "Set-Cookie",
        sessionCookie(
          result.sessionId,
          Math.floor((result.expiresAt - Date.now()) / 1000),
          config.secureCookies,
        ),
      );
      sendJson(response, 200, { ok: true });
    } catch {
      sendJson(response, 400, { error: "请求格式无效" });
    }
    return true;
  }

  if (pathname === "/api/session" && request.method === "GET") {
    const authenticated = isAuthenticated(request);
    if (!authenticated) {
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    const tunnelState = frpTunnel?.getState();
    sendJson(response, 200, {
      authenticated: true,
      mirror: mirror.getState(),
      tunnel: tunnelState
        ? { phase: tunnelState.phase, label: tunnelState.label }
        : { phase: "disabled" },
    });
    return true;
  }

  if (pathname === "/api/logout" && request.method === "POST") {
    if (!sameOrigin(request)) {
      sendJson(response, 403, { error: "请求来源无效" });
      return true;
    }
    const sessionId = sessionIdFor(request);
    auth.revoke(sessionId);
    closeSessionSockets(sessionId, "Session revoked");
    response.setHeader("Set-Cookie", sessionCookie("", 0, config.secureCookies));
    sendJson(response, 200, { ok: true });
    return true;
  }
  return false;
}

function serveStatic(response: ServerResponse, pathname: string): void {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const normalized = path.normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = path.join(config.staticRoot, normalized);
  if (!filePath.startsWith(config.staticRoot + path.sep) && filePath !== config.staticRoot) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(config.staticRoot, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    sendJson(response, 503, { error: "Client build is missing. Run npm run build:client." });
    return;
  }
  const extension = path.extname(filePath);
  response.writeHead(200, {
    "Content-Type": mimeTypes[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable",
    ...(usesSecurePublicAccess ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    "Content-Security-Policy": [
      "default-src 'self'",
      "connect-src 'self' ws: wss:",
      "img-src 'self' blob: data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  fs.createReadStream(filePath).pipe(response);
}

const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url || "/", "http://remote-codex.local");
  if (url.pathname === "/healthz" && request.method === "GET") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (gatewayAccess && !gatewayAccess.accepts(request.headers)) {
    sendJson(response, 403, { error: "Gateway authentication required" });
    return;
  }
  if (url.pathname.startsWith("/api/") && await routeApi(request, response, url.pathname)) return;
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }
  serveStatic(response, url.pathname);
};

const server = config.tlsCertPath && config.tlsKeyPath
  ? https.createServer({
      cert: fs.readFileSync(config.tlsCertPath),
      key: fs.readFileSync(config.tlsKeyPath),
      minVersion: "TLSv1.3",
    }, requestHandler)
  : http.createServer(requestHandler);

const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 131_072,
  perMessageDeflate: false,
});
const clients = new Set<WebSocket>();
const frameBroadcaster = new LatestFrameBroadcaster({ maxInFlight: 2 });
const controlLease = new ControlLease<WebSocket>({
  isOpen: (socket) => socket.readyState === WebSocket.OPEN,
});

function send(socket: WebSocket, message: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

const nativeCapture = new MacOSNativeCapture({
  binary: config.nativeCaptureBinary,
  bundleId: config.nativeCaptureBundleId,
  profiles: {
    normal: {
      fps: config.videoNormalFps,
      maxWidth: config.videoNormalMaxWidth,
      bitrate: config.videoNormalBitrate,
    },
    high: {
      fps: config.videoHighFps,
      maxWidth: config.videoHighMaxWidth,
      bitrate: config.videoHighBitrate,
    },
  },
});
const videoService = config.videoTransport === "auto"
  ? new WebRtcVideoService(nativeCapture, config.webRtcIceServers, (socket, phase, detail) => {
      frameBroadcaster.setEnabled(socket, phase !== "active");
      send(socket, { type: "video/status", phase, detail });
    })
  : undefined;

function broadcastJson(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

function publishControlState(): void {
  for (const client of clients) {
    send(client, {
      type: "control",
      ...controlLease.stateFor(client),
    });
  }
}

function publishPresence(): void {
  broadcastJson({ type: "presence", connectedClients: clients.size });
}

const streamStatsTimer = setInterval(() => {
  for (const client of clients) {
    const stats = frameBroadcaster.stats(client);
    if (!stats) continue;
    send(client, {
      type: "stream/stats",
      roundTripMs: stats.roundTripMs,
      droppedFrames: stats.droppedFrames,
      inFlight: stats.inFlight,
    });
  }
}, 1_000);
streamStatsTimer.unref();

function requestControl(socket: WebSocket): void {
  controlLease.request(socket);
  publishControlState();
}

function validSubmission(message: Extract<ClientMessage, { type: "input/submit" }>): boolean {
  return typeof message.id === "string"
    && /^[A-Za-z0-9_-]{1,64}$/.test(message.id)
    && typeof message.text === "string"
    && Boolean(message.text.trim())
    && message.text.length <= 16_384
    && (message.takeControl === undefined || typeof message.takeControl === "boolean");
}

async function handleInput(socket: WebSocket, message: ClientMessage): Promise<void> {
  if (message.type === "control/request") {
    requestControl(socket);
    return;
  }
  if (message.type === "input/submit" && !validSubmission(message)) return;
  if (message.type === "input/submit" && message.takeControl) {
    controlLease.takeover(socket);
    publishControlState();
  }
  if (!controlLease.touch(socket)) {
    send(socket, { type: "error", error: "当前设备没有控制权" });
    return;
  }
  const state = mirror.getState();
  const width = state.viewport?.width || 16_384;
  const height = state.viewport?.height || 16_384;

  if (message.type === "stream/quality") {
    if (!["normal", "high"].includes(message.profile)) return;
    await Promise.all([
      mirror.setQualityProfile(message.profile),
      videoService?.setProfile(message.profile),
    ]);
    return;
  }

  if (message.type === "input/pointer") {
    if (
      !finiteNumber(message.x, 0, width)
      || !finiteNumber(message.y, 0, height)
      || !validModifiers(message.modifiers)
      || !["move", "down", "up"].includes(message.event)
      || (message.button !== undefined && !["left", "right", "middle"].includes(message.button))
      || (message.buttons !== undefined && !finiteNumber(message.buttons, 0, 7))
      || (message.clickCount !== undefined && !finiteNumber(message.clickCount, 0, 3))
    ) return;
    const types = { move: "mouseMoved", down: "mousePressed", up: "mouseReleased" } as const;
    await mirror.dispatchPointer({
      type: types[message.event],
      x: message.x,
      y: message.y,
      button: message.button || (message.event === "move" ? "none" : "left"),
      buttons: message.buttons,
      clickCount: message.clickCount,
      modifiers: message.modifiers,
    });
    return;
  }

  if (message.type === "input/wheel") {
    if (
      !finiteNumber(message.x, 0, width)
      || !finiteNumber(message.y, 0, height)
      || !finiteNumber(message.deltaX, -2_000, 2_000)
      || !finiteNumber(message.deltaY, -2_000, 2_000)
      || !validModifiers(message.modifiers)
    ) return;
    await mirror.dispatchWheel(message);
    return;
  }

  if (message.type === "input/text") {
    if (typeof message.text !== "string" || message.text.length > 16_384) return;
    await mirror.insertText(message.text);
    return;
  }

  if (message.type === "input/submit") {
    try {
      await mirror.submitText(message.text);
      send(socket, { type: "submission", id: message.id, ok: true });
    } catch (error) {
      send(socket, {
        type: "submission",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : "消息发送失败",
      });
    }
    return;
  }

  if (message.type === "input/command") {
    if (!["enter", "backspace", "escape", "tab"].includes(message.command)) return;
    await mirror.command(message.command);
    return;
  }

  if (message.type === "input/key") {
    if (
      !["keyDown", "keyUp", "rawKeyDown", "char"].includes(message.event)
      || typeof message.key !== "string"
      || typeof message.code !== "string"
      || message.key.length > 64
      || message.code.length > 64
      || (message.text !== undefined && (typeof message.text !== "string" || message.text.length > 64))
      || !validModifiers(message.modifiers)
      || (message.repeat !== undefined && typeof message.repeat !== "boolean")
      || (message.location !== undefined && !finiteNumber(message.location, 0, 3))
    ) return;
    await mirror.dispatchKey({
      type: message.event,
      key: message.key,
      code: message.code,
      text: message.text,
      modifiers: message.modifiers,
      repeat: message.repeat,
      location: message.location,
    });
  }
}

const inputScheduler = new RemoteInputScheduler<WebSocket>(handleInput, (socket, error) => {
  send(socket, {
    type: "error",
    error: error instanceof Error ? error.message : "输入转发失败",
  });
});

websocketServer.on("connection", (socket, request) => {
  const sessionId = sessionIdFor(request);
  const sessionExpiresAt = auth.expiresAt(sessionId);
  if (!sessionId || !sessionExpiresAt) {
    socket.close(1008, "Session invalid");
    return;
  }
  const sockets = sessionSockets.get(sessionId) || new Set<WebSocket>();
  sockets.add(socket);
  sessionSockets.set(sessionId, sockets);
  const sessionExpiryTimer = setTimeout(() => {
    auth.revoke(sessionId);
    closeSessionSockets(sessionId, "Session expired");
  }, Math.max(0, sessionExpiresAt - Date.now()));
  sessionExpiryTimer.unref();

  clients.add(socket);
  frameBroadcaster.add(socket);
  let windowStartedAt = Date.now();
  let messagesInWindow = 0;
  requestControl(socket);
  publishPresence();
  send(socket, { type: "mirror/state", state: mirror.getState() });
  send(socket, {
    type: "video/capability",
    ...(videoService?.capability() || { available: false, iceServers: [] }),
  });

  socket.on("message", (raw) => {
    if (!auth.validate(sessionId)) {
      closeSessionSockets(sessionId, "Session invalid");
      return;
    }
    const now = Date.now();
    if (now - windowStartedAt >= 1_000) {
      windowStartedAt = now;
      messagesInWindow = 0;
    }
    messagesInWindow += 1;
    if (messagesInWindow > 240) {
      socket.close(1008, "Rate limit exceeded");
      return;
    }
    const message = parseClientMessage(raw.toString());
    if (!message) return;
    if (message.type === "frame/ack") {
      if (Number.isInteger(message.sequence) && message.sequence >= 0 && message.sequence <= 0xffff_ffff) {
        frameBroadcaster.acknowledge(socket, message.sequence);
      }
      return;
    }
    if (message.type === "webrtc/offer") {
      if (typeof message.sdp !== "string") return;
      if (!videoService) {
        send(socket, { type: "video/status", phase: "fallback", detail: "WebRTC 视频已禁用" });
        return;
      }
      void videoService.handleOffer(socket, message.sdp).catch((error) => {
        console.warn("WebRTC video fallback:", error instanceof Error ? error.message : error);
        frameBroadcaster.setEnabled(socket, true);
        send(socket, {
          type: "video/status",
          phase: "fallback",
          detail: error instanceof Error ? error.message : "WebRTC 视频启动失败",
        });
      });
      return;
    }
    if (message.type === "video/ready") {
      videoService?.confirmActive(socket);
      return;
    }
    inputScheduler.enqueue(socket, message);
  });

  socket.on("close", () => {
    clearTimeout(sessionExpiryTimer);
    const activeSessionSockets = sessionSockets.get(sessionId);
    activeSessionSockets?.delete(socket);
    if (activeSessionSockets?.size === 0) sessionSockets.delete(sessionId);
    clients.delete(socket);
    frameBroadcaster.remove(socket);
    void videoService?.close(socket);
    publishPresence();
    if (controlLease.release(socket)) publishControlState();
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://remote-codex.local");
  const sessionId = sessionIdFor(request);
  if (
    url.pathname !== "/ws"
    || (gatewayAccess && !gatewayAccess.accepts(request.headers))
    || !sameOrigin(request)
    || !auth.validate(sessionId)
  ) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket, request);
  });
});

mirror.on("state", (state: MirrorState) => broadcastJson({ type: "mirror/state", state }));
let frameSequence = 0;
mirror.on("frame", (frame: MirrorFrame) => {
  frameSequence = (frameSequence + 1) >>> 0;
  const packet = encodeFramePacket({
    sequence: frameSequence,
    capturedAt: Date.now(),
    sourceWidth: Math.max(0, Math.round(frame.metadata.deviceWidth || 0)),
    sourceHeight: Math.max(0, Math.round(frame.metadata.deviceHeight || 0)),
    jpeg: Buffer.from(frame.data, "base64"),
  });
  frameBroadcaster.publish(frameSequence, packet);
});

server.listen(config.port, config.host, async () => {
  const protocol = config.tlsCertPath ? "https" : "http";
  console.log("\nMy Remote Codex");
  console.log(`Pairing code: ${auth.code}`);
  console.log(`Local URL: ${protocol}://127.0.0.1:${config.port}`);
  if (config.host === "0.0.0.0" || config.host === "::") {
    for (const entries of Object.values(os.networkInterfaces())) {
      for (const entry of entries || []) {
        if (entry.family === "IPv4" && !entry.internal) {
          console.log(`Network URL: ${protocol}://${entry.address}:${config.port}`);
        }
      }
    }
  }
  if (!config.tlsCertPath && config.host !== "127.0.0.1" && config.host !== "::1") {
    console.warn("Warning: LAN mode is using HTTP. Configure TLS before using an untrusted network.");
  }
  console.log(`CDP endpoint: 127.0.0.1:${config.cdpPort}\n`);
  mirror.start();
  if (frpTunnel) {
    try {
      await frpTunnel.start();
      console.log(`FRP tunnel: running (${frpTunnel.getState().label})`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      void shutdown(1);
    }
  }
});

let shuttingDown = false;

async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(streamStatsTimer);
  mirror.stop();
  await videoService?.stop();
  for (const client of clients) client.close(1001, "Server shutting down");
  const forceExit = setTimeout(() => process.exit(1), 3_000);
  forceExit.unref();
  try {
    await frpTunnel?.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  } finally {
    clearTimeout(forceExit);
    process.exit(exitCode);
  }
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
