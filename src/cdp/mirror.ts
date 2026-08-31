import { EventEmitter } from "node:events";
import { FrameRateGate } from "../frame-transport.js";
import { cdpKeyEvent, type RemoteKeyInput } from "./keyboard.js";
import { CdpSession } from "./session.js";
import { discoverAppTargets, type CdpTarget } from "./target.js";

export interface MirrorFrame {
  data: string;
  sessionId: number;
  metadata: {
    deviceWidth?: number;
    deviceHeight?: number;
    pageScaleFactor?: number;
    offsetTop?: number;
    scrollOffsetX?: number;
    scrollOffsetY?: number;
    timestamp?: number;
  };
}

export interface MirrorState {
  phase: "stopped" | "discovering" | "connected" | "disconnected";
  qualityProfile: StreamQualityProfile;
  captureMode?: CaptureMode;
  targetTitle?: string;
  viewport?: { width: number; height: number };
  editableRegions?: Array<{ left: number; top: number; width: number; height: number }>;
  stream?: StreamSettings;
  detail?: string;
}

export type StreamQualityProfile = "normal" | "high";
export type CaptureMode = "screencast" | "screenshot-fallback";

export interface StreamSettings {
  jpegQuality: number;
  maxWidth: number;
  maxHeight: number;
  maxFps: number;
}

export interface MirrorOptions {
  cdpPort: number;
  jpegQuality: number;
  maxFrameWidth: number;
  maxFrameHeight: number;
  normalMaxFps: number;
  highJpegQuality: number;
  highMaxFrameWidth: number;
  highMaxFrameHeight: number;
  highMaxFps: number;
  backgroundCaptureDelayMs?: number;
  backgroundCaptureIntervalMs?: number;
  reconnectDelayMs?: number;
}

interface TargetProbe {
  codex: boolean;
  visible: boolean;
  width: number;
  height: number;
  deviceScaleFactor: number;
  editableRegions: Array<{ left: number; top: number; width: number; height: number }>;
}

const PROBE_EXPRESSION = `(() => {
  const main = document.querySelector('main, [role="main"]');
  const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
  const shell = document.querySelector('[data-testid="app-shell-header-context-menu-surface"]');
  const editableRegions = [...document.querySelectorAll(
    'input:not([type="hidden"]), textarea, [contenteditable="true"], [role="textbox"]'
  )].flatMap((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (
      rect.width <= 0
      || rect.height <= 0
      || style.visibility === 'hidden'
      || style.display === 'none'
      || style.pointerEvents === 'none'
    ) return [];
    return [{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }];
  });
  return {
    codex: location.protocol === 'app:' && Boolean(document.body) && Boolean(main || input || shell),
    visible: document.visibilityState === 'visible',
    width: innerWidth,
    height: innerHeight,
    deviceScaleFactor: Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1,
    editableRegions
  };
})()`;

const FOCUS_COMPOSER_EXPRESSION = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none';
  };
  const candidates = [...document.querySelectorAll(
    'textarea, [contenteditable="true"][role="textbox"], [role="textbox"]'
  )].filter(visible);
  const byBottom = (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom;
  const editor = candidates.filter((element) => element.getAttribute('aria-label')).sort(byBottom)[0]
    || candidates.sort(byBottom)[0];
  if (!editor || editor.getAttribute('aria-disabled') === 'true' || editor.disabled) return false;
  editor.focus();
  if (editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement) {
    editor.setSelectionRange(editor.value.length, editor.value.length);
  } else if (editor.isContentEditable) {
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return document.activeElement === editor;
})()`;

const COMPOSER_EMPTY_EXPRESSION = `(() => {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0
      && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none';
  };
  const candidates = [...document.querySelectorAll(
    'textarea, [contenteditable="true"][role="textbox"], [role="textbox"]'
  )].filter(visible);
  const byBottom = (left, right) => right.getBoundingClientRect().bottom - left.getBoundingClientRect().bottom;
  const editor = candidates.filter((element) => element.getAttribute('aria-label')).sort(byBottom)[0]
    || candidates.sort(byBottom)[0];
  if (!editor) return false;
  const text = editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
    ? editor.value
    : editor.textContent || '';
  return text.length === 0;
})()`;

export class CdpMirror extends EventEmitter {
  private session?: CdpSession;
  private activeProbe?: TargetProbe;
  private backgroundCaptureTimer?: NodeJS.Timeout;
  private backgroundHidden = false;
  private lastFrameAt = 0;
  private stopped = true;
  private qualityProfile: StreamQualityProfile = "normal";
  private qualityUpdate: Promise<void> = Promise.resolve();
  private state: MirrorState = { phase: "stopped", qualityProfile: "normal" };
  private readonly frameRateGate: FrameRateGate;

  constructor(private readonly options: MirrorOptions) {
    super();
    this.frameRateGate = new FrameRateGate(options.normalMaxFps);
  }

  getState(): MirrorState {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.run();
  }

  stop(): void {
    this.stopped = true;
    this.session?.close();
    this.session = undefined;
    this.activeProbe = undefined;
    this.stopBackgroundCaptureMonitor();
    this.updateState({ phase: "stopped", qualityProfile: this.qualityProfile });
  }

  setQualityProfile(profile: StreamQualityProfile): Promise<void> {
    const update = this.qualityUpdate.then(() => this.applyQualityProfile(profile));
    this.qualityUpdate = update.catch(() => {});
    return update;
  }

  async dispatchPointer(input: {
    type: "mouseMoved" | "mousePressed" | "mouseReleased";
    x: number;
    y: number;
    button?: "none" | "left" | "right" | "middle";
    buttons?: number;
    clickCount?: number;
    modifiers?: number;
  }): Promise<void> {
    await this.requiredSession().send("Input.dispatchMouseEvent", {
      type: input.type,
      x: input.x,
      y: input.y,
      button: input.button || "none",
      buttons: input.buttons || 0,
      clickCount: input.clickCount || 0,
      modifiers: input.modifiers || 0,
      pointerType: "mouse",
    });
  }

  async dispatchWheel(input: {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers?: number;
  }): Promise<void> {
    await this.requiredSession().send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: input.x,
      y: input.y,
      deltaX: input.deltaX,
      deltaY: input.deltaY,
      modifiers: input.modifiers || 0,
    });
  }

  async dispatchKey(input: RemoteKeyInput): Promise<void> {
    await this.requiredSession().send("Input.dispatchKeyEvent", cdpKeyEvent(input));
  }

  async insertText(text: string): Promise<void> {
    await this.requiredSession().send("Input.insertText", { text });
  }

  async submitText(text: string): Promise<void> {
    const session = this.requiredSession();
    const focused = await session.evaluate<boolean>(FOCUS_COMPOSER_EXPRESSION);
    if (!focused) throw new Error("没有找到可用的 Codex 输入框");
    await session.send("Input.insertText", { text });
    await this.command("enter");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await session.evaluate<boolean>(COMPOSER_EMPTY_EXPRESSION)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Codex 未确认这条补充消息，内容已保留在远程输入栏");
  }

  async command(command: "enter" | "backspace" | "escape" | "tab"): Promise<void> {
    const keys = {
      enter: { key: "Enter", code: "Enter", text: "\r" },
      backspace: { key: "Backspace", code: "Backspace", text: "" },
      escape: { key: "Escape", code: "Escape", text: "" },
      tab: { key: "Tab", code: "Tab", text: "\t" },
    } as const;
    const key = keys[command];
    const session = this.requiredSession();
    await session.send("Input.dispatchKeyEvent", cdpKeyEvent({
      type: "rawKeyDown",
      key: key.key,
      code: key.code,
      text: key.text,
    }));
    await session.send("Input.dispatchKeyEvent", cdpKeyEvent({
      type: "keyUp",
      key: key.key,
      code: key.code,
    }));
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectAndStream();
      } catch (error) {
        if (this.stopped) break;
        this.updateState({
          phase: "disconnected",
          qualityProfile: this.qualityProfile,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      if (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, this.options.reconnectDelayMs || 1_000));
      }
    }
  }

  private async connectAndStream(): Promise<void> {
    this.updateState({ phase: "discovering", qualityProfile: this.qualityProfile });
    const targets = await discoverAppTargets(this.options.cdpPort);
    if (!targets.length) throw new Error(`CDP 端口 ${this.options.cdpPort} 上没有可信的 app:// 页面`);

    const selected = await this.selectTarget(targets);
    if (!selected) throw new Error("没有找到符合预期结构的 Codex 渲染页面");
    const { target, session, probe } = selected;
    this.session = session;
    this.activeProbe = probe;

    session.on("event", (method: string, params: unknown) => {
      if (method !== "Page.screencastFrame" || !params || typeof params !== "object") return;
      const frame = params as MirrorFrame;
      if (typeof frame.data !== "string" || !Number.isInteger(frame.sessionId)) return;
      const capturedAt = Date.now();
      this.lastFrameAt = capturedAt;
      if (!this.backgroundHidden) this.setCaptureMode("screencast");
      if (this.frameRateGate.shouldPublish(capturedAt)) this.emit("frame", frame);
      void session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }, 2_000).catch(() => {});
    });

    const stream = this.streamSettings(probe, this.qualityProfile);
    this.lastFrameAt = Date.now();
    this.backgroundHidden = false;
    this.frameRateGate.reset();
    await this.startScreencast(session, stream);
    await this.captureScreenshotFrame(session, probe, false).catch(() => false);
    this.updateState({
      phase: "connected",
      qualityProfile: this.qualityProfile,
      captureMode: "screencast",
      targetTitle: target.title || "Codex",
      viewport: { width: probe.width, height: probe.height },
      editableRegions: probe.editableRegions,
      stream,
    });
    this.startBackgroundCaptureMonitor(session, probe);
    await session.waitUntilClosed();
    if (this.session === session) {
      this.stopBackgroundCaptureMonitor();
      this.session = undefined;
      this.activeProbe = undefined;
    }
  }

  private async selectTarget(
    targets: CdpTarget[],
  ): Promise<{ target: CdpTarget; session: CdpSession; probe: TargetProbe } | undefined> {
    const candidates: Array<{
      target: CdpTarget;
      session: CdpSession;
      probe: TargetProbe;
      score: number;
    }> = [];
    for (const target of targets) {
      const session = new CdpSession(target, this.options.cdpPort);
      try {
        await session.open();
        await session.send("Runtime.enable");
        await session.send("Page.enable");
        const probe = await session.evaluate<TargetProbe>(PROBE_EXPRESSION);
        if (!probe?.codex || probe.width < 320 || probe.height < 240) {
          session.close();
          continue;
        }
        candidates.push({
          target,
          session,
          probe,
          score: (probe.visible ? 1_000_000 : 0) + probe.width * probe.height,
        });
      } catch {
        session.close();
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    const winner = candidates.shift();
    for (const candidate of candidates) candidate.session.close();
    return winner;
  }

  private requiredSession(): CdpSession {
    if (!this.session || this.state.phase !== "connected") {
      throw new Error("Codex 渲染页面尚未连接");
    }
    return this.session;
  }

  private async applyQualityProfile(profile: StreamQualityProfile): Promise<void> {
    if (profile === this.qualityProfile) return;
    const session = this.requiredSession();
    const probe = this.activeProbe;
    if (!probe) throw new Error("Codex 页面尺寸尚未就绪");

    const previousProfile = this.qualityProfile;
    const previousStream = this.streamSettings(probe, previousProfile);
    const nextStream = this.streamSettings(probe, profile);
    await session.send("Page.stopScreencast");
    try {
      await this.startScreencast(session, nextStream);
      this.qualityProfile = profile;
      this.frameRateGate.setMaxFps(nextStream.maxFps);
    } catch (error) {
      await this.startScreencast(session, previousStream).catch(() => {});
      throw error;
    }

    this.updateState({
      ...this.state,
      qualityProfile: profile,
      stream: nextStream,
    });
  }

  private streamSettings(probe: TargetProbe, profile: StreamQualityProfile): StreamSettings {
    if (profile === "normal") {
      return {
        jpegQuality: this.options.jpegQuality,
        maxWidth: this.options.maxFrameWidth,
        maxHeight: this.options.maxFrameHeight,
        maxFps: this.options.normalMaxFps,
      };
    }
    const scale = Number.isFinite(probe.deviceScaleFactor) && probe.deviceScaleFactor > 0
      ? Math.min(probe.deviceScaleFactor, 4)
      : 1;
    return {
      jpegQuality: this.options.highJpegQuality,
      maxWidth: Math.min(Math.ceil(probe.width * scale), this.options.highMaxFrameWidth),
      maxHeight: Math.min(Math.ceil(probe.height * scale), this.options.highMaxFrameHeight),
      maxFps: this.options.highMaxFps,
    };
  }

  private async startScreencast(session: CdpSession, stream: StreamSettings): Promise<void> {
    await session.send("Page.startScreencast", {
      format: "jpeg",
      quality: stream.jpegQuality,
      maxWidth: stream.maxWidth,
      maxHeight: stream.maxHeight,
      everyNthFrame: 1,
    });
  }

  private startBackgroundCaptureMonitor(session: CdpSession, probe: TargetProbe): void {
    this.stopBackgroundCaptureMonitor();
    const intervalMs = this.options.backgroundCaptureIntervalMs || 1_000;
    const tick = async (): Promise<void> => {
      if (this.stopped || this.session !== session || this.state.phase !== "connected") return;
      try {
        const delayMs = this.options.backgroundCaptureDelayMs || 1_500;
        const stale = Date.now() - this.lastFrameAt >= delayMs;
        if (this.backgroundHidden || stale) {
          const visibility = await session.evaluate<string>("document.visibilityState");
          this.backgroundHidden = visibility === "hidden";
          if (this.backgroundHidden) {
            await this.captureScreenshotFrame(session, probe, true);
          } else {
            this.lastFrameAt = Date.now();
            this.setCaptureMode("screencast");
          }
        }
      } catch {
        // A transient screenshot failure should not tear down the primary CDP session.
      } finally {
        if (!this.stopped && this.session === session && this.state.phase === "connected") {
          this.backgroundCaptureTimer = setTimeout(() => void tick(), intervalMs);
        }
      }
    };
    this.backgroundCaptureTimer = setTimeout(() => void tick(), intervalMs);
  }

  private async captureScreenshotFrame(
    session: CdpSession,
    probe: TargetProbe,
    fallback: boolean,
  ): Promise<boolean> {
    const stream = this.streamSettings(probe, this.qualityProfile);
    const screenshot = await session.send<{ data?: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: stream.jpegQuality,
      fromSurface: true,
      captureBeyondViewport: false,
      optimizeForSpeed: true,
    }, 2_000);
    if (typeof screenshot.data !== "string" || !screenshot.data) return false;
    this.lastFrameAt = Date.now();
    if (fallback) this.setCaptureMode("screenshot-fallback");
    this.emit("frame", {
      data: screenshot.data,
      sessionId: 0,
      metadata: {
        deviceWidth: probe.width,
        deviceHeight: probe.height,
        pageScaleFactor: 1,
      },
    } satisfies MirrorFrame);
    return true;
  }

  private stopBackgroundCaptureMonitor(): void {
    if (this.backgroundCaptureTimer) clearTimeout(this.backgroundCaptureTimer);
    this.backgroundCaptureTimer = undefined;
    this.backgroundHidden = false;
  }

  private setCaptureMode(captureMode: CaptureMode): void {
    if (this.state.phase !== "connected" || this.state.captureMode === captureMode) return;
    this.updateState({ ...this.state, captureMode });
  }

  private updateState(state: MirrorState): void {
    this.state = state;
    this.emit("state", state);
  }
}
