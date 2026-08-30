import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeCaptureAppPath } from "../src/video/native-capture.js";

describe("macOS native capture bundle", () => {
  it("packages a launchable application with a Screen Recording usage description", () => {
    const plist = fs.readFileSync(
      path.resolve("native/macos-capture/Resources/Info.plist"),
      "utf8",
    );
    const script = fs.readFileSync(path.resolve("scripts/build-native-macos.sh"), "utf8");
    const source = fs.readFileSync(
      path.resolve("native/macos-capture/Sources/RemoteCodexCapture/main.swift"),
      "utf8",
    );
    expect(plist).toContain("com.myremotecodex.capture");
    expect(plist).toContain("My Remote Codex Capture");
    expect(plist).toContain("NSScreenCaptureUsageDescription");
    expect(script).toContain("codesign");
    expect(script).toContain("--identifier com.myremotecodex.capture");
    expect(script).toContain('architecture="${TARGET_ARCH:-$(uname -m)}"');
    expect(script).toContain('--arch "${architecture}"');
    expect(source).toContain("NWListener");
    expect(source).toContain("127.0.0.1");
    expect(source).toContain("my-remote-codex-capture.token");
    expect(source).toContain("com.openai.codex");
    expect(source).toContain("import AppKit");
    expect(source).toMatch(/@MainActor\s+static func main\(\)/);
    expect(source).toContain("NSApplication.shared.run()");
    expect(source).not.toContain("dispatchMain()");
    expect(source).toMatch(/@MainActor\s+static func startCapture/);
  });

  it("derives the application bundle from its packaged executable", () => {
    expect(nativeCaptureAppPath(
      "/tmp/My Remote Codex Capture.app/Contents/MacOS/remote-codex-capture",
    )).toBe("/tmp/My Remote Codex Capture.app");
    expect(nativeCaptureAppPath("/tmp/remote-codex-capture")).toBeUndefined();
  });
});
