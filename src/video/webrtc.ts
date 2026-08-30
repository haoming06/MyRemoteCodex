import {
  MediaStream,
  MediaStreamTrack,
  RTCPeerConnection,
  useH264,
} from "werift";
import type { WebSocket } from "ws";
import { H264RtpPacketizer } from "./h264-packetizer.js";
import type { H264Frame } from "./frame-stream.js";
import { MacOSNativeCapture, type VideoQualityProfile } from "./native-capture.js";

export interface WebRtcIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type VideoSessionPhase = "connecting" | "active" | "fallback";

export class VideoActivationGate {
  private connected = false;
  private frameSeen = false;
  private clientReady = false;
  private active = false;

  markConnected(): boolean {
    this.connected = true;
    return this.activateOnce();
  }

  markFrameSeen(): boolean {
    this.frameSeen = true;
    return this.activateOnce();
  }

  markClientReady(): boolean {
    this.clientReady = true;
    return this.activateOnce();
  }

  private activateOnce(): boolean {
    if (this.active || !this.connected || !this.frameSeen || !this.clientReady) return false;
    this.active = true;
    return true;
  }
}

interface VideoSession {
  peer: RTCPeerConnection;
  frameHandler: (frame: H264Frame) => void;
  activation: VideoActivationGate;
  activationTimer?: NodeJS.Timeout;
}

export class WebRtcVideoService {
  private readonly sessions = new Map<WebSocket, VideoSession>();
  private captureStopTimer?: NodeJS.Timeout;

  constructor(
    private readonly capture: MacOSNativeCapture,
    private readonly iceServers: WebRtcIceServer[],
    private readonly onPhase: (socket: WebSocket, phase: VideoSessionPhase, detail?: string) => void,
  ) {}

  capability(): { available: boolean; iceServers: WebRtcIceServer[] } {
    return { available: this.capture.available(), iceServers: this.iceServers };
  }

  async handleOffer(socket: WebSocket, sdp: string): Promise<void> {
    if (!this.capture.available()) throw new Error("H.264 原生采集不可用");
    if (!sdp || sdp.length > 128_000 || !sdp.startsWith("v=0")) {
      throw new Error("WebRTC offer 无效");
    }
    await this.close(socket);
    if (this.captureStopTimer) clearTimeout(this.captureStopTimer);
    this.onPhase(socket, "connecting");

    const codec = useH264({ payloadType: 96 });
    const peer = new RTCPeerConnection({
      codecs: { video: [codec] },
      iceServers: this.iceServers,
      iceUseIpv4: true,
      iceUseIpv6: true,
    });
    const track = new MediaStreamTrack({ kind: "video" });
    const stream = new MediaStream();
    stream.addTrack(track);
    const sender = peer.addTrack(track, stream);
    const packetizer = new H264RtpPacketizer(codec.payloadType ?? 96);
    let session: VideoSession;
    const frameHandler = (frame: H264Frame) => {
      try {
        for (const packet of packetizer.packetize(frame)) track.writeRtp(packet);
        this.activateSession(socket, session, session.activation.markFrameSeen());
      } catch (error) {
        this.onPhase(socket, "fallback", error instanceof Error ? error.message : "H.264 RTP 分包失败");
        void this.close(socket);
      }
    };
    this.capture.on("frame", frameHandler);
    sender.onPictureLossIndication.subscribe(() => this.capture.requestKeyframe());
    peer.connectionStateChange.subscribe((state) => {
      if (this.sessions.get(socket)?.peer !== peer) return;
      if (state === "connected") {
        this.capture.requestKeyframe();
        if (!session.activationTimer) {
          session.activationTimer = setTimeout(() => {
            if (this.sessions.get(socket) !== session) return;
            this.onPhase(socket, "fallback", "浏览器未确认 H.264 首帧");
            void this.close(socket);
          }, 5_000);
          session.activationTimer.unref();
        }
        this.activateSession(socket, session, session.activation.markConnected());
      }
      if (state === "failed" || state === "disconnected" || state === "closed") {
        this.onPhase(socket, "fallback", `WebRTC ${state}`);
        void this.close(socket);
      }
    });
    session = { peer, frameHandler, activation: new VideoActivationGate() };
    this.sessions.set(socket, session);

    try {
      await this.capture.start();
      await peer.setRemoteDescription({ type: "offer", sdp });
      const answer = await peer.createAnswer();
      const localDescription = await peer.setLocalDescription(answer);
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ type: "webrtc/answer", sdp: localDescription.toJSON().sdp }));
      }
    } catch (error) {
      await this.close(socket);
      throw error;
    }
  }

  confirmActive(socket: WebSocket): boolean {
    const session = this.sessions.get(socket);
    if (!session) return false;
    this.activateSession(socket, session, session.activation.markClientReady());
    return true;
  }

  async setProfile(profile: VideoQualityProfile): Promise<void> {
    await this.capture.setProfile(profile);
  }

  async close(socket: WebSocket): Promise<void> {
    const session = this.sessions.get(socket);
    if (!session) return;
    this.sessions.delete(socket);
    if (session.activationTimer) clearTimeout(session.activationTimer);
    this.capture.off("frame", session.frameHandler);
    await session.peer.close().catch(() => undefined);
    if (this.sessions.size === 0) {
      this.captureStopTimer = setTimeout(() => void this.capture.stop(), 2_000);
      this.captureStopTimer.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.captureStopTimer) clearTimeout(this.captureStopTimer);
    await Promise.all([...this.sessions.keys()].map((socket) => this.close(socket)));
    await this.capture.stop();
  }

  private activateSession(socket: WebSocket, session: VideoSession, activated: boolean): void {
    if (!activated || this.sessions.get(socket) !== session) return;
    if (session.activationTimer) clearTimeout(session.activationTimer);
    session.activationTimer = undefined;
    this.onPhase(socket, "active");
  }
}
