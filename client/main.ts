import {
  createIcons,
  Hand,
  Keyboard,
  Languages,
  LockKeyhole,
  LogOut,
  Maximize,
  MonitorSmartphone,
  MousePointer2,
  Radio,
  RotateCcw,
  ScanLine,
  Send,
  Trash2,
  X,
} from "lucide";
import { decodeFramePacket, type FramePacket } from "../src/frame-transport";
import type { ClientMessage } from "../src/protocol";
import { clampZoom, fitScale, pointToSource, type SourceSize } from "./geometry";
import { AnimationFrameCoalescer, mergeWheelInputs } from "./input-coalescer";
import {
  alternateLanguage,
  languageStorageKey,
  resolveLanguage,
  translate,
  translateServerText,
  type Language,
  type TranslationKey,
} from "./i18n";
import { buildSubmissionMessage, remainingComposerTextAfterSuccess } from "./submission";
import {
  singleTouchAction,
  updatePinchGesture,
  type PinchGestureState,
  type TouchMode,
} from "./touch-gestures";
import {
  forgetPairingCode,
  loadPairingCodeHistory,
  rememberPairingCode,
} from "./pairing-code-history";
import "./styles.css";

const icons = {
  Hand,
  Keyboard,
  Languages,
  LockKeyhole,
  LogOut,
  Maximize,
  MonitorSmartphone,
  MousePointer2,
  Radio,
  RotateCcw,
  ScanLine,
  Send,
  Trash2,
  X,
};

function renderIcons(): void {
  createIcons({ icons, attrs: { "stroke-width": 1.8 } });
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

const pairView = required<HTMLElement>("#pair-view");
const pairForm = required<HTMLFormElement>("#pair-form");
const pairCode = required<HTMLInputElement>("#pair-code");
const pairError = required<HTMLOutputElement>("#pair-error");
const pairHistory = required<HTMLElement>("#pair-history");
const pairHistoryList = required<HTMLUListElement>("#pair-history-list");
const remoteView = required<HTMLElement>("#remote-view");
const connectionState = required<HTMLElement>("#connection-state");
const connectionLabel = required<HTMLElement>("#connection-label");
const streamStats = required<HTMLOutputElement>("#stream-stats");
const stage = required<HTMLElement>("#stage");
const canvas = required<HTMLCanvasElement>("#remote-canvas");
const remoteVideo = required<HTMLVideoElement>("#remote-video");
const drawingContext = canvas.getContext("2d", { alpha: false });
if (!drawingContext) throw new Error("Canvas 2D is unavailable");
const renderer: CanvasRenderingContext2D = drawingContext;
const emptyState = required<HTMLElement>("#empty-state");
const emptyTitle = required<HTMLElement>("#empty-title");
const emptyDetail = required<HTMLElement>("#empty-detail");
const qualityButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-quality-profile]")];
const modeButton = required<HTMLButtonElement>("#mode-button");
const modeIndicator = required<HTMLElement>("#mode-indicator");
const fitButton = required<HTMLButtonElement>("#fit-button");
const resetButton = required<HTMLButtonElement>("#reset-button");
const fullscreenButton = required<HTMLButtonElement>("#fullscreen-button");
const logoutButton = required<HTMLButtonElement>("#logout-button");
const composerForm = required<HTMLFormElement>("#composer-form");
const composerInput = required<HTMLTextAreaElement>("#composer-input");
const composerStatus = required<HTMLOutputElement>("#composer-status");
const clearComposerButton = required<HTMLButtonElement>("#clear-composer-button");
const sendButton = required<HTMLButtonElement>("#send-button");
const keyboardCapture = required<HTMLTextAreaElement>("#keyboard-capture");
const codexPet = required<HTMLButtonElement>("#codex-pet");
const terminalCount = required<HTMLElement>("#terminal-count");
const petStatus = required<HTMLElement>("#pet-status");
const languageButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-language-toggle]")];

type QualityProfile = "normal" | "high";
type PetExpression = "neutral" | "happy" | "curious" | "sleepy" | "surprised";
type ServerMessage =
  | { type: "mirror/state"; state: MirrorState }
  | { type: "control"; granted: boolean; occupied: boolean }
  | { type: "stream/stats"; roundTripMs?: number; droppedFrames: number; inFlight: number }
  | { type: "video/capability"; available: boolean; iceServers: RTCIceServer[] }
  | { type: "video/status"; phase: "connecting" | "active" | "fallback"; detail?: string }
  | { type: "webrtc/answer"; sdp: string }
  | { type: "presence"; connectedClients: number }
  | { type: "submission"; id: string; ok: boolean; error?: string }
  | { type: "error"; error: string };
type MirrorState = {
  phase: "stopped" | "discovering" | "connected" | "disconnected";
  qualityProfile?: QualityProfile;
  captureMode?: "screencast" | "screenshot-fallback";
  detail?: string;
  viewport?: SourceSize;
};
type ConnectionLabelSource = TranslationKey | { serverText: string };
let authenticated = false;
let socket: WebSocket | undefined;
let videoPeer: RTCPeerConnection | undefined;
let videoPhase: "jpeg" | "connecting" | "active" = "jpeg";
let videoFallbackDetail: string | undefined;
let reconnectTimer: number | undefined;
let hasControl = false;
let mirrorConnected = false;
let qualityProfile: QualityProfile = "normal";
let captureMode: "screencast" | "screenshot-fallback" = "screencast";
let touchMode: TouchMode = "browse";
let source: SourceSize = { width: 1280, height: 800 };
let fit = true;
let userZoom = 1;
let panX = 0;
let panY = 0;
let pendingFrame: FramePacket | undefined;
let decodingFrame = false;
let captureComposing = false;
let composerComposing = false;
let pendingSubmission: { id: string; text: string } | undefined;
let connectedClients = 0;
let petRunning = false;
let petExpressionTimer: number | undefined;
let petExpressionResetTimer: number | undefined;
let statsReceivedBytes = 0;
let statsDisplayedFrames = 0;
let statsDecodeMs = 0;
let statsRoundTripMs: number | undefined;
let statsDroppedFrames = 0;
let statsStartedAt = performance.now();
let currentLanguage: Language = resolveLanguage(
  window.localStorage.getItem(languageStorageKey),
  navigator.language,
);
let connectionLabelSource: ConnectionLabelSource = "connecting";
let latestMirrorState: MirrorState | undefined;
let pairErrorSource: string | undefined;
let savedPairingCodes = loadPairingCodeHistory(window.localStorage);

function t(key: TranslationKey, variables?: Record<string, string | number>): string {
  return translate(key, currentLanguage, variables);
}

function resolveConnectionLabel(source: ConnectionLabelSource): string {
  return typeof source === "string"
    ? t(source)
    : translateServerText(source.serverText, currentLanguage);
}

function localizeClientError(value: string): string {
  return value === "连接失败"
    ? t("connectionFailed")
    : translateServerText(value, currentLanguage);
}

function applyStaticTranslations(): void {
  document.documentElement.lang = currentLanguage;
  for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n as TranslationKey);
  }
  const attributes = ["title", "aria-label", "placeholder"] as const;
  for (const attribute of attributes) {
    const dataAttribute = `data-i18n-${attribute}`;
    for (const element of document.querySelectorAll<HTMLElement>(`[${dataAttribute}]`)) {
      const key = element.getAttribute(dataAttribute) as TranslationKey;
      element.setAttribute(attribute, t(key));
    }
  }
  composerInput.lang = currentLanguage;
  for (const button of languageButtons) {
    const targetIsEnglish = currentLanguage === "zh-CN";
    const label = button.querySelector<HTMLElement>("span");
    if (label) label.textContent = targetIsEnglish ? "EN" : "中";
    const title = t(targetIsEnglish ? "switchToEnglish" : "switchToChinese");
    button.title = title;
    button.setAttribute("aria-label", title);
  }
  renderPairingCodeHistory();
}

function renderPairingCodeHistory(): void {
  pairHistory.hidden = savedPairingCodes.length === 0;
  pairHistoryList.replaceChildren(...savedPairingCodes.map((code) => {
    const item = document.createElement("li");
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "pair-history-code";
    selectButton.dataset.pairingCode = code;
    selectButton.title = t("useSavedPairingCode", { code });
    selectButton.setAttribute("aria-label", selectButton.title);
    selectButton.textContent = code;

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "pair-history-delete";
    deleteButton.dataset.deletePairingCode = code;
    deleteButton.title = t("deleteSavedPairingCode", { code });
    deleteButton.setAttribute("aria-label", deleteButton.title);
    deleteButton.innerHTML = '<i data-lucide="trash-2"></i>';
    item.append(selectButton, deleteButton);
    return item;
  }));
  renderIcons();
}

function setLanguage(language: Language): void {
  currentLanguage = language;
  window.localStorage.setItem(languageStorageKey, language);
  applyStaticTranslations();
  connectionLabel.textContent = resolveConnectionLabel(connectionLabelSource);
  if (latestMirrorState) updateMirrorState(latestMirrorState);
  if (pairErrorSource) pairError.textContent = localizeClientError(pairErrorSource);
  updatePet();
  updateModeControl(false);
  setSubmissionBusy(pendingSubmission !== undefined);
}

type PointerInput = Extract<ClientMessage, { type: "input/pointer" }>;
type WheelInput = Extract<ClientMessage, { type: "input/wheel" }>;

const pointerMoves = new AnimationFrameCoalescer<PointerInput>(
  (message) => { send(message); },
  (_previous, next) => next,
);
const wheelInputs = new AnimationFrameCoalescer<WheelInput>(
  (message) => { send(message); },
  mergeWheelInputs,
);

const touches = new Map<number, { x: number; y: number; startX: number; startY: number }>();
let pinch: PinchGestureState | undefined;

function send(message: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function setSubmissionBusy(busy: boolean): void {
  sendButton.disabled = busy;
  composerForm.setAttribute("aria-busy", String(busy));
  sendButton.title = busy ? t("sending") : t("send");
  sendButton.setAttribute("aria-label", sendButton.title);
}

function updateComposerInput(): void {
  composerInput.style.height = "auto";
  if (composerInput.value) {
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 116)}px`;
  }
  const hasContent = composerInput.value.length > 0;
  clearComposerButton.disabled = !hasContent;
  clearComposerButton.setAttribute("aria-hidden", String(!hasContent));
  clearComposerButton.classList.toggle("is-visible", hasContent);
}

function clearComposerInput(): void {
  composerInput.value = "";
  updateComposerInput();
}

function resolveSubmission(message: Extract<ServerMessage, { type: "submission" }>): void {
  if (!pendingSubmission || message.id !== pendingSubmission.id) return;
  const submittedText = pendingSubmission.text;
  pendingSubmission = undefined;
  setSubmissionBusy(false);
  if (message.ok) {
    const remainingText = remainingComposerTextAfterSuccess(composerInput.value, submittedText);
    if (remainingText !== composerInput.value) {
      composerInput.value = remainingText;
      updateComposerInput();
    }
    composerStatus.textContent = t("sent");
  } else {
    composerStatus.textContent = message.error
      ? translateServerText(message.error, currentLanguage)
      : t("sendFailed");
  }
  composerInput.focus({ preventScroll: true });
}

function setConnection(
  phase: "connecting" | "online" | "offline",
  source: ConnectionLabelSource,
): void {
  connectionState.dataset.phase = phase;
  connectionLabelSource = source;
  connectionLabel.textContent = resolveConnectionLabel(source);
  updatePet(phase);
}

function updatePet(connectionPhase?: "connecting" | "online" | "offline"): void {
  const phase = connectionPhase || connectionState.dataset.phase || "connecting";
  const state = phase === "online" ? (hasControl ? "control" : "online") : phase;
  codexPet.dataset.state = state;
  terminalCount.textContent = String(connectedClients);
  petStatus.textContent = petRunning
    ? t("petRunning")
    : phase === "connecting"
      ? t("petConnecting")
      : phase === "offline"
        ? t("petOffline")
        : hasControl
          ? t("petControlling")
          : t("petObserving");
  codexPet.setAttribute(
    "aria-label",
    t("petAccessibility", { count: connectedClients, status: petStatus.textContent }),
  );
}

function finishPetRun(): void {
  if (!petRunning) return;
  petRunning = false;
  codexPet.classList.remove("is-running");
  updatePet();
  schedulePetExpression();
}

const petExpressions: Exclude<PetExpression, "neutral">[] = [
  "happy",
  "curious",
  "sleepy",
  "surprised",
];

function randomMilliseconds(minimum: number, maximum: number): number {
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
}

function resetPetExpression(): void {
  window.clearTimeout(petExpressionResetTimer);
  petExpressionResetTimer = undefined;
  codexPet.dataset.expression = "neutral";
}

function stopPetExpressions(): void {
  window.clearTimeout(petExpressionTimer);
  window.clearTimeout(petExpressionResetTimer);
  petExpressionTimer = undefined;
  petExpressionResetTimer = undefined;
  codexPet.dataset.expression = "neutral";
}

function schedulePetExpression(): void {
  window.clearTimeout(petExpressionTimer);
  petExpressionTimer = undefined;
  if (!authenticated || petRunning) return;
  petExpressionTimer = window.setTimeout(() => {
    if (!authenticated || petRunning) {
      schedulePetExpression();
      return;
    }
    const expression = petExpressions[Math.floor(Math.random() * petExpressions.length)] || "happy";
    codexPet.dataset.expression = expression;
    petExpressionResetTimer = window.setTimeout(() => {
      resetPetExpression();
      schedulePetExpression();
    }, randomMilliseconds(3_000, 5_000));
  }, randomMilliseconds(15_000, 30_000));
}

function onlineConnectionLabel(): TranslationKey {
  if (captureMode === "screenshot-fallback") return hasControl ? "backgroundRefresh" : "backgroundView";
  return hasControl ? "connected" : "viewOnly";
}

function updateQualityControl(): void {
  for (const button of qualityButtons) {
    const selected = button.dataset.qualityProfile === qualityProfile;
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = !hasControl || !mirrorConnected;
  }
}

function setAuthenticated(value: boolean): void {
  authenticated = value;
  pairView.hidden = value;
  remoteView.hidden = !value;
  if (value) {
    schedulePetExpression();
    connectSocket();
    stage.focus({ preventScroll: true });
  } else {
    stopPetExpressions();
    window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = undefined;
    closeVideoPeer();
    videoFallbackDetail = undefined;
    canvas.hidden = true;
    remoteVideo.hidden = true;
    emptyState.hidden = false;
  }
}

function updateMirrorState(state: MirrorState): void {
  latestMirrorState = state;
  mirrorConnected = state.phase === "connected";
  qualityProfile = state.qualityProfile || "normal";
  captureMode = state.captureMode || "screencast";
  if (state.viewport?.width && state.viewport?.height) source = state.viewport;
  if (mirrorConnected) {
    setConnection("online", onlineConnectionLabel());
    emptyTitle.textContent = t("displayConnecting");
    emptyDetail.textContent = t("waitingForFirstFrame");
  } else {
    setConnection("offline", "codexDisconnected");
    canvas.hidden = true;
    remoteVideo.hidden = true;
    emptyState.hidden = false;
    emptyTitle.textContent = t("waitingForCodex");
    emptyDetail.textContent = state.detail
      ? translateServerText(state.detail, currentLanguage)
      : t("startCodexWithDebugPort");
  }
  updateQualityControl();
  updateTransform();
}

function closeVideoPeer(): void {
  videoPeer?.close();
  videoPeer = undefined;
  videoPhase = "jpeg";
  remoteVideo.pause();
  remoteVideo.srcObject = null;
  remoteVideo.hidden = true;
  remoteVideo.classList.remove("has-frame");
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const timeout = window.setTimeout(done, 5_000);
    function done(): void {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      resolve();
    }
    function changed(): void {
      if (peer.iceGatheringState === "complete") done();
    }
    peer.addEventListener("icegatheringstatechange", changed);
  });
}

async function startWebRtcVideo(iceServers: RTCIceServer[]): Promise<void> {
  if (!socket || typeof RTCPeerConnection === "undefined") return;
  closeVideoPeer();
  videoFallbackDetail = undefined;
  videoPhase = "connecting";
  const peer = new RTCPeerConnection({ iceServers });
  videoPeer = peer;
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.addEventListener("track", (event) => {
    if (peer !== videoPeer) return;
    remoteVideo.srcObject = event.streams[0] || new MediaStream([event.track]);
    void remoteVideo.play().catch(() => undefined);
  });
  peer.addEventListener("connectionstatechange", () => {
    if (peer !== videoPeer) return;
    if (peer.connectionState === "failed" || peer.connectionState === "disconnected") {
      closeVideoPeer();
    }
  });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForIceGathering(peer);
  if (peer !== videoPeer || !peer.localDescription) return;
  send({ type: "webrtc/offer", sdp: peer.localDescription.sdp });
}

remoteVideo.addEventListener("loadeddata", () => {
  if (!remoteVideo.srcObject) return;
  videoPhase = "active";
  videoFallbackDetail = undefined;
  remoteVideo.hidden = false;
  remoteVideo.classList.add("has-frame");
  canvas.hidden = true;
  emptyState.hidden = true;
  updateTransform();
  send({ type: "video/ready" });
});

function connectSocket(): void {
  if (!authenticated || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  setConnection("connecting", "connecting");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws`);
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => send({ type: "control/request" }));
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      try {
        statsReceivedBytes += event.data.byteLength;
        const frame = decodeFramePacket(new Uint8Array(event.data));
        send({ type: "frame/ack", sequence: frame.sequence });
        if (videoPhase !== "active") queueFrame(frame);
      } catch {
        setConnection("offline", "invalidFrameData");
      }
      return;
    }
    let message: ServerMessage;
    try {
      message = JSON.parse(String(event.data)) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === "mirror/state") updateMirrorState(message.state);
    if (message.type === "control") {
      hasControl = message.granted;
      updateQualityControl();
      if (mirrorConnected) setConnection("online", onlineConnectionLabel());
    }
    if (message.type === "presence") {
      connectedClients = Number.isInteger(message.connectedClients)
        ? Math.max(0, message.connectedClients)
        : 0;
      updatePet();
    }
    if (message.type === "stream/stats") {
      statsRoundTripMs = message.roundTripMs;
      statsDroppedFrames = message.droppedFrames;
    }
    if (message.type === "video/capability") {
      if (message.available) {
        void startWebRtcVideo(message.iceServers).catch((error: unknown) => {
          videoFallbackDetail = error instanceof Error ? error.message : "浏览器无法启动 WebRTC";
          closeVideoPeer();
        });
      }
      else videoFallbackDetail = "H.264 原生采集程序不可用";
    }
    if (message.type === "webrtc/answer" && videoPeer) {
      void videoPeer.setRemoteDescription({ type: "answer", sdp: message.sdp })
        .catch(() => closeVideoPeer());
    }
    if (message.type === "video/status") {
      if (message.phase === "connecting") videoPhase = "connecting";
      if (message.phase === "fallback") {
        videoFallbackDetail = message.detail || "WebRTC 视频连接失败";
        closeVideoPeer();
      }
    }
    if (message.type === "submission") resolveSubmission(message);
    if (message.type === "error") setConnection("offline", { serverText: message.error });
  });
  socket.addEventListener("close", () => {
    socket = undefined;
    closeVideoPeer();
    pointerMoves.clear();
    wheelInputs.clear();
    hasControl = false;
    connectedClients = 0;
    updatePet("connecting");
    updateQualityControl();
    pendingSubmission = undefined;
    setSubmissionBusy(false);
    if (!authenticated) return;
    setConnection("connecting", "reconnecting");
    reconnectTimer = window.setTimeout(connectSocket, 1200);
  });
}

function queueFrame(frame: FramePacket): void {
  pendingFrame = frame;
  if (!decodingFrame) void decodeNextFrame();
}

async function decodeNextFrame(): Promise<void> {
  const frame = pendingFrame;
  if (!frame) return;
  pendingFrame = undefined;
  decodingFrame = true;
  const decodeStartedAt = performance.now();
  try {
    const bitmap = await createImageBitmap(new Blob([
      frame.jpeg as Uint8Array<ArrayBuffer>,
    ], { type: "image/jpeg" }));
    let layoutChanged = false;
    if (
      frame.sourceWidth > 0
      && frame.sourceHeight > 0
      && (source.width !== frame.sourceWidth || source.height !== frame.sourceHeight)
    ) {
      source = { width: frame.sourceWidth, height: frame.sourceHeight };
      layoutChanged = true;
    }
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      layoutChanged = true;
    }
    renderer.drawImage(bitmap, 0, 0);
    bitmap.close();
    canvas.hidden = false;
    canvas.classList.add("has-frame");
    emptyState.hidden = true;
    if (layoutChanged) updateTransform();
    statsDisplayedFrames += 1;
    statsDecodeMs += performance.now() - decodeStartedAt;
  } catch {
    setConnection("offline", "frameDecodeFailed");
  } finally {
    decodingFrame = false;
    if (pendingFrame) void decodeNextFrame();
  }
}

function renderStreamStats(): void {
  const now = performance.now();
  const elapsedMs = Math.max(1, now - statsStartedAt);
  if (!authenticated || !mirrorConnected) {
    streamStats.hidden = true;
  } else {
    const fps = statsDisplayedFrames * 1_000 / elapsedMs;
    const kilobitsPerSecond = statsReceivedBytes * 8 / elapsedMs;
    const bandwidth = kilobitsPerSecond >= 1_000
      ? `${(kilobitsPerSecond / 1_000).toFixed(1)} Mbps`
      : `${Math.round(kilobitsPerSecond)} Kbps`;
    const roundTrip = statsRoundTripMs === undefined ? "-- ms" : `${Math.round(statsRoundTripMs)} ms`;
    const averageDecodeMs = statsDisplayedFrames ? statsDecodeMs / statsDisplayedFrames : 0;
    const jpegActivity = fps > 0 ? `${Math.round(fps)} fps · ${bandwidth}` : t("still");
    const fallbackState = videoFallbackDetail?.includes("屏幕录制权限")
      ? t("waitingForScreenPermission")
      : videoFallbackDetail?.includes("启动") || videoFallbackDetail?.includes("连接")
        ? t("captureNotStarted")
        : videoFallbackDetail
          ? t("webRtcFallback")
          : undefined;
    streamStats.textContent = videoPhase === "active"
      ? `H.264 · ${remoteVideo.videoWidth || source.width}×${remoteVideo.videoHeight || source.height}`
      : `JPEG${fallbackState ? ` · ${fallbackState}` : ""} · ${jpegActivity} · ${roundTrip}`;
    streamStats.title = videoFallbackDetail
      ? t("jpegFallbackDetail", { detail: translateServerText(videoFallbackDetail, currentLanguage) })
      : t("decodeStats", { ms: averageDecodeMs.toFixed(1), dropped: statsDroppedFrames });
    streamStats.hidden = false;
  }
  statsReceivedBytes = 0;
  statsDisplayedFrames = 0;
  statsDecodeMs = 0;
  statsStartedAt = now;
}

window.setInterval(renderStreamStats, 1_000);

function effectiveScale(): number {
  const base = fit ? fitScale({ width: stage.clientWidth, height: stage.clientHeight }, source) : 1;
  return base * userZoom;
}

function updateTransform(): void {
  const scale = effectiveScale();
  const centeredX = (stage.clientWidth - source.width * scale) / 2;
  const centeredY = (stage.clientHeight - source.height * scale) / 2;
  const transform = `translate(${centeredX + panX}px, ${centeredY + panY}px) scale(${scale})`;
  for (const surface of [canvas, remoteVideo]) {
    surface.style.width = `${source.width}px`;
    surface.style.height = `${source.height}px`;
    surface.style.transform = transform;
  }
}

function remoteSurface(): HTMLCanvasElement | HTMLVideoElement {
  return videoPhase === "active" && !remoteVideo.hidden ? remoteVideo : canvas;
}

function sourcePoint(clientX: number, clientY: number) {
  return pointToSource(clientX, clientY, remoteSurface().getBoundingClientRect(), source);
}

function isRemoteSurface(target: EventTarget | null): boolean {
  return target === canvas || target === remoteVideo;
}

function zoomAt(nextZoom: number, clientX: number, clientY: number): void {
  const before = sourcePoint(clientX, clientY);
  userZoom = clampZoom(nextZoom);
  fit = true;
  updateTransform();
  const after = sourcePoint(clientX, clientY);
  const scale = effectiveScale();
  panX += (after.x - before.x) * scale;
  panY += (after.y - before.y) * scale;
  updateTransform();
}

function modifiers(event: MouseEvent | PointerEvent | WheelEvent | KeyboardEvent): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0);
}

function buttonName(button: number): "left" | "middle" | "right" {
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return "left";
}

function sendPointer(event: PointerEvent, phase: "down" | "move" | "up"): void {
  const point = sourcePoint(event.clientX, event.clientY);
  const message: PointerInput = {
    type: "input/pointer",
    event: phase,
    x: point.x,
    y: point.y,
    button: buttonName(event.button),
    buttons: event.buttons,
    modifiers: modifiers(event),
    clickCount: event.detail || 1,
  };
  if (phase === "move") {
    pointerMoves.enqueue(message);
    return;
  }
  pointerMoves.flush();
  wheelInputs.flush();
  send(message);
}

function queueWheel(message: WheelInput): void {
  wheelInputs.enqueue(message);
}

function distanceBetweenTouches(): number {
  const [first, second] = [...touches.values()];
  if (!first || !second) return 0;
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function centerBetweenTouches(): { x: number; y: number } {
  const [first, second] = [...touches.values()];
  if (!first || !second) return { x: 0, y: 0 };
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

stage.addEventListener("pointerdown", (event) => {
  if (!hasControl || !mirrorConnected || !isRemoteSurface(event.target)) return;
  stage.focus({ preventScroll: true });
  event.preventDefault();
  stage.setPointerCapture(event.pointerId);
  if (event.pointerType === "touch") {
    touches.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY });
    if (touches.size === 2) {
      if (touchMode === "direct") {
        const first = [...touches.values()][0];
        if (first) {
          const point = sourcePoint(first.x, first.y);
          send({ type: "input/pointer", event: "up", x: point.x, y: point.y, button: "left", buttons: 0, modifiers: 0, clickCount: 1 });
        }
      }
      const center = centerBetweenTouches();
      pinch = { distance: distanceBetweenTouches(), zoom: userZoom, centerX: center.x, centerY: center.y };
    } else if (touchMode === "direct") {
      sendPointer(event, "down");
    }
    return;
  }
  sendPointer(event, "down");
});

stage.addEventListener("pointermove", (event) => {
  if (!hasControl || !mirrorConnected || !stage.hasPointerCapture(event.pointerId)) return;
  event.preventDefault();
  if (event.pointerType !== "touch") {
    sendPointer(event, "move");
    return;
  }
  const current = touches.get(event.pointerId);
  if (!current) return;
  const previousX = current.x;
  const previousY = current.y;
  current.x = event.clientX;
  current.y = event.clientY;
  if (touches.size === 2 && pinch) {
    const center = centerBetweenTouches();
    const update = updatePinchGesture(pinch, distanceBetweenTouches(), center.x, center.y);
    zoomAt(update.zoom, center.x, center.y);
    panX += update.panX;
    panY += update.panY;
    pinch = update.state;
    updateTransform();
    return;
  }
  const action = singleTouchAction(touchMode);
  if (action === "pointer") {
    sendPointer(event, "move");
    return;
  }
  const deltaX = current.x - previousX;
  const deltaY = current.y - previousY;
  const point = sourcePoint(event.clientX, event.clientY);
  queueWheel({ type: "input/wheel", x: point.x, y: point.y, deltaX: -deltaX * 1.4, deltaY: -deltaY * 1.4, modifiers: 0 });
});

function finishPointer(event: PointerEvent): void {
  if (!stage.hasPointerCapture(event.pointerId)) return;
  event.preventDefault();
  const touch = touches.get(event.pointerId);
  if (event.pointerType === "touch" && touch) {
    const moved = Math.hypot(event.clientX - touch.startX, event.clientY - touch.startY);
    if (touchMode === "direct") {
      sendPointer(event, "up");
    } else if (touches.size === 1 && moved < 9) {
      sendPointer(event, "down");
      sendPointer(event, "up");
    }
    touches.delete(event.pointerId);
    if (touches.size < 2) pinch = undefined;
  } else if (event.pointerType !== "touch") {
    sendPointer(event, "up");
    window.setTimeout(() => keyboardCapture.focus({ preventScroll: true }), 0);
  }
  stage.releasePointerCapture(event.pointerId);
}

stage.addEventListener("pointerup", finishPointer);
stage.addEventListener("pointercancel", finishPointer);
stage.addEventListener("contextmenu", (event) => event.preventDefault());
stage.addEventListener("wheel", (event) => {
  if (!hasControl || !mirrorConnected || !isRemoteSurface(event.target)) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(userZoom * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    return;
  }
  const point = sourcePoint(event.clientX, event.clientY);
  queueWheel({ type: "input/wheel", x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiers(event) });
}, { passive: false });

stage.addEventListener("keydown", (event) => {
  if (!hasControl || !mirrorConnected) return;
  const fromCapture = event.target === keyboardCapture;
  const plainText = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
  const localPaste = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
  if (fromCapture && (captureComposing || event.isComposing || event.keyCode === 229 || plainText || localPaste)) return;
  event.preventDefault();
  send({
    type: "input/key",
    event: "keyDown",
    key: event.key,
    code: event.code,
    text: event.key.length === 1 && !event.metaKey && !event.ctrlKey ? event.key : undefined,
    modifiers: modifiers(event),
    repeat: event.repeat,
    location: event.location,
  });
});

stage.addEventListener("keyup", (event) => {
  if (!hasControl || !mirrorConnected) return;
  const fromCapture = event.target === keyboardCapture;
  const plainText = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
  const localPaste = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v";
  if (fromCapture && (captureComposing || event.isComposing || event.keyCode === 229 || plainText || localPaste)) return;
  event.preventDefault();
  send({
    type: "input/key",
    event: "keyUp",
    key: event.key,
    code: event.code,
    modifiers: modifiers(event),
    location: event.location,
  });
});

function flushKeyboardCapture(): void {
  if (captureComposing) return;
  const text = keyboardCapture.value;
  if (!text) return;
  keyboardCapture.value = "";
  if (hasControl && mirrorConnected) send({ type: "input/text", text });
}

keyboardCapture.addEventListener("compositionstart", () => {
  captureComposing = true;
});

keyboardCapture.addEventListener("compositionend", () => {
  captureComposing = false;
  queueMicrotask(flushKeyboardCapture);
});

keyboardCapture.addEventListener("input", (event) => {
  if (!(event as InputEvent).isComposing) flushKeyboardCapture();
});

pairHistoryList.addEventListener("click", (event) => {
  const target = event.target as Element;
  const deleteButton = target.closest<HTMLButtonElement>("[data-delete-pairing-code]");
  if (deleteButton?.dataset.deletePairingCode) {
    savedPairingCodes = forgetPairingCode(
      window.localStorage,
      deleteButton.dataset.deletePairingCode,
    );
    renderPairingCodeHistory();
    return;
  }

  const selectButton = target.closest<HTMLButtonElement>("[data-pairing-code]");
  if (!selectButton?.dataset.pairingCode) return;
  pairCode.value = selectButton.dataset.pairingCode;
  pairCode.focus();
  pairCode.select();
});

pairForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  pairErrorSource = undefined;
  pairError.textContent = "";
  const button = pairForm.querySelector<HTMLButtonElement>("button[type=submit]");
  if (button) button.disabled = true;
  const submittedCode = pairCode.value.trim();
  try {
    const response = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: submittedCode }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error || "连接失败");
    savedPairingCodes = rememberPairingCode(window.localStorage, submittedCode);
    renderPairingCodeHistory();
    pairCode.value = "";
    setAuthenticated(true);
  } catch (error) {
    pairErrorSource = error instanceof Error ? error.message : "连接失败";
    pairError.textContent = localizeClientError(pairErrorSource);
  } finally {
    if (button) button.disabled = false;
  }
});

composerForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = composerInput.value;
  if (!text.trim() || !mirrorConnected || pendingSubmission) return;
  const id = crypto.randomUUID();
  pendingSubmission = { id, text };
  composerStatus.textContent = hasControl ? t("sending") : t("takingControlAndSending");
  setSubmissionBusy(true);
  const sent = send(buildSubmissionMessage({ id, text }));
  if (!sent) {
    pendingSubmission = undefined;
    setSubmissionBusy(false);
    composerStatus.textContent = t("connectionLostBeforeSend");
  }
});

composerInput.addEventListener("input", () => {
  updateComposerInput();
});

clearComposerButton.addEventListener("click", () => {
  clearComposerInput();
  composerStatus.textContent = "";
  composerInput.focus({ preventScroll: true });
});

composerInput.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter"
    && !event.shiftKey
    && !event.isComposing
    && !composerComposing
    && event.keyCode !== 229
  ) {
    event.preventDefault();
    composerForm.requestSubmit();
  }
});

composerInput.addEventListener("compositionstart", () => {
  composerComposing = true;
});

composerInput.addEventListener("compositionend", () => {
  composerComposing = false;
});

codexPet.addEventListener("click", () => {
  if (petRunning) return;
  stopPetExpressions();
  petRunning = true;
  codexPet.classList.add("is-running");
  updatePet();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.setTimeout(finishPetRun, reducedMotion ? 300 : 2_100);
});

codexPet.addEventListener("animationend", (event) => {
  if (event.target === codexPet && event.animationName === "pet-trip") finishPetRun();
});

for (const button of qualityButtons) {
  button.addEventListener("click", () => {
    const profile = button.dataset.qualityProfile;
    if (
      (profile !== "normal" && profile !== "high")
      || profile === qualityProfile
      || !hasControl
      || !mirrorConnected
    ) return;
    send({ type: "stream/quality", profile });
  });
}

function updateModeControl(showIndicator: boolean): void {
  const direct = touchMode === "direct";
  modeButton.innerHTML = `<i data-lucide="${direct ? "mouse-pointer-2" : "hand"}"></i>`;
  modeButton.title = direct ? t("directTouch") : t("browseMode");
  modeButton.setAttribute("aria-label", modeButton.title);
  modeIndicator.innerHTML = `<i data-lucide="${direct ? "mouse-pointer-2" : "hand"}"></i><span>${direct ? t("directTouch") : t("browse")}</span>`;
  if (showIndicator) {
    modeIndicator.classList.add("visible");
    window.setTimeout(() => modeIndicator.classList.remove("visible"), 900);
  }
  renderIcons();
}

modeButton.addEventListener("click", () => {
  touchMode = touchMode === "browse" ? "direct" : "browse";
  updateModeControl(true);
});

fitButton.addEventListener("click", () => {
  fit = true;
  userZoom = 1;
  panX = 0;
  panY = 0;
  updateTransform();
});

resetButton.addEventListener("click", () => {
  fit = false;
  userZoom = 1;
  panX = 0;
  panY = 0;
  updateTransform();
});

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await remoteView.requestFullscreen();
});

logoutButton.addEventListener("click", async () => {
  authenticated = false;
  await fetch("/api/logout", { method: "POST" }).catch(() => undefined);
  setAuthenticated(false);
});

for (const button of languageButtons) {
  button.addEventListener("click", () => setLanguage(alternateLanguage(currentLanguage)));
}

new ResizeObserver(updateTransform).observe(stage);
window.visualViewport?.addEventListener("resize", updateTransform);

async function bootstrap(): Promise<void> {
  applyStaticTranslations();
  renderIcons();
  canvas.hidden = true;
  remoteVideo.hidden = true;
  try {
    const response = await fetch("/api/session", { cache: "no-store" });
    const body = await response.json() as { authenticated: boolean; mirror?: MirrorState };
    if (body.mirror) updateMirrorState(body.mirror);
    setAuthenticated(body.authenticated);
  } catch {
    pairError.textContent = t("localServiceUnavailable");
    setAuthenticated(false);
  }
}

void bootstrap();
