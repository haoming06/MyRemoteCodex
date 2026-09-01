import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS installer", () => {
  const buildScript = path.resolve("scripts/build-macos-installer.sh");
  const buildAllScript = path.resolve("scripts/build-macos-installers.sh");
  const downloadNodeScript = path.resolve("scripts/download-node-macos.sh");
  const buildIcnsScript = path.resolve("scripts/build-icns.mjs");
  const iconScript = path.resolve("scripts/generate-app-icon.sh");
  const setupScript = path.resolve("scripts/setup-frp.sh");
  const hostSources = [
    "LauncherConfig.swift",
    "AppModel.swift",
    "ContentView.swift",
    "MyRemoteCodexApp.swift",
  ].map((name) => fs.readFileSync(
    path.resolve("native/macos-host/Sources/MyRemoteCodexHost", name),
    "utf8",
  )).join("\n");

  it("has valid packaging and FRP download scripts", () => {
    expect(() => execFileSync("bash", ["-n", buildScript])).not.toThrow();
    expect(() => execFileSync("bash", ["-n", buildAllScript])).not.toThrow();
    expect(() => execFileSync("bash", ["-n", downloadNodeScript])).not.toThrow();
    expect(() => execFileSync("bash", ["-n", iconScript])).not.toThrow();
    expect(() => execFileSync("bash", ["-n", setupScript])).not.toThrow();
    const script = fs.readFileSync(buildScript, "utf8");
    expect(script).toContain("npm prune --omit=dev");
    expect(script).toContain('setup-frp.sh" download \\\n');
    expect(script).toContain("--binary frpc");
    expect(script).toContain("codesign --verify --deep --strict");
    expect(script).toContain("Node.entitlements");
    expect(script).toContain("--component-plist");
    expect(script).toContain('package_root="$build_root/pkg-root"');
    expect(script).toContain('$package_root/Applications');
    expect(script).toContain("pkgbuild");
    expect(script).toContain("hdiutil create");
    expect(script).toContain('codesign --force --sign "$identity" --timestamp "$dmg_path"');
    expect(script).toContain('notarytool submit "$dmg_path"');
    expect(script).toContain('stapler staple "$dmg_path"');
    expect(script).toContain('stapler validate "$dmg_path"');
    expect(script).toContain("AppIcon.png");
    expect(script).toContain("AppIcon.icns");
    expect(script).toContain('architecture="${TARGET_ARCH:-$(uname -m)}"');
    expect(script).toContain('verify_architecture "$runtime/node"');
    expect(script).toContain('--arch "$architecture"');
  });

  it("publishes unsigned Apple Silicon and Intel DMGs without Apple secrets", () => {
    const workflow = fs.readFileSync(
      path.resolve(".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("types: [published]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("release_tag:");
    expect(workflow).toContain(
      "github.event_name == 'workflow_dispatch' && github.sha || github.event.release.tag_name",
    );
    expect(workflow).toContain("architecture: arm64");
    expect(workflow).toContain("architecture: x86_64");
    expect(workflow).toContain("runner: macos-15-intel");
    expect(workflow).not.toContain("MACOS_CERTIFICATE_BASE64");
    expect(workflow).not.toContain("MACOS_CERTIFICATE_PASSWORD");
    expect(workflow).not.toContain("APPLE_APP_SPECIFIC_PASSWORD");
    expect(workflow).not.toContain("NOTARY_KEYCHAIN_PROFILE");
    expect(workflow).toContain(
      'npm version "${RELEASE_TAG#v}" --no-git-tag-version --allow-same-version',
    );
    expect(workflow).not.toContain("does not match package version");
    expect(workflow).toContain("npm run build:macos:installer");
    expect(workflow).toContain('--repo "$GITHUB_REPOSITORY"');
  });

  it("builds separate arm64 and x86_64 installers", () => {
    const script = fs.readFileSync(buildAllScript, "utf8");
    expect(script).toContain("for architecture in arm64 x86_64");
    expect(script).toContain('TARGET_ARCH="$architecture"');
    expect(script).toContain("My-Remote-Codex-${version}-${architecture}.dmg");
    expect(script).toContain("Both architecture-specific DMGs are required.");

    const invalidDownload = spawnSync("bash", [
      downloadNodeScript,
      "--version", "22.0.0",
      "--arch", "powerpc",
      "--output", path.join(os.tmpdir(), "node"),
    ], { encoding: "utf8" });
    expect(invalidDownload.status).toBe(1);
    expect(invalidDownload.stderr).toContain("--arch must be arm64 or x86_64");
  });

  it("packages a standard macOS application icon", () => {
    const plist = fs.readFileSync(
      path.resolve("native/macos-host/Resources/Info.plist"),
      "utf8",
    );
    const script = fs.readFileSync(iconScript, "utf8");
    const sourceIcon = fs.statSync(path.resolve("native/macos-host/Resources/AppIcon.png"));

    expect(plist).toContain("CFBundleIconFile");
    expect(plist).toContain("AppIcon");
    expect(script).toContain("icon_512x512@2x.png");
    expect(script).toContain("build-icns.mjs");
    expect(fs.readFileSync(buildIcnsScript, "utf8")).toContain("writeUInt32BE");
    expect(sourceIcon.size).toBeGreaterThan(100_000);
  });

  it("builds an icon whose outer canvas is transparent", () => {
    const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "my-remote-codex-icon-"));
    const outputIcon = path.join(temporaryDirectory, "AppIcon.icns");
    try {
      execFileSync(iconScript, [
        path.resolve("native/macos-host/Resources/AppIcon.png"),
        outputIcon,
      ]);
      expect(fs.readFileSync(outputIcon, "ascii").slice(0, 4)).toBe("icns");
    } finally {
      fs.rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("keeps settings and secrets local while managing the packaged service", () => {
    expect(hostSources).toContain(".applicationSupportDirectory");
    expect(hostSources).toContain(".posixPermissions: 0o600");
    expect(hostSources).toContain("REMOTE_CODEX_FRP_ENABLED");
    expect(hostSources).toContain("REMOTE_CODEX_PUBLIC_ORIGIN");
    expect(hostSources).toContain("授权的外部 HTTPS 来源");
    expect(hostSources).toContain("questionmark.circle");
    expect(hostSources).toContain(".lineLimit(1)");
    expect(hostSources).toContain(".fixedSize(horizontal: true, vertical: false)");
    expect(hostSources).toContain("127.0.0.1");
    expect(hostSources).toContain("连接测试");
    expect(hostSources).toContain("FRP token");
  });

  it("uses stable bundle identifiers", () => {
    const plist = fs.readFileSync(
      path.resolve("native/macos-host/Resources/Info.plist"),
      "utf8",
    );
    expect(plist).toContain("com.myremotecodex.host");
    expect(plist).toContain("my-remote-codex-host");
  });

  it("always installs the app into Applications so Launchpad can index it", () => {
    const componentPlist = fs.readFileSync(
      path.resolve("native/macos-host/Resources/PackageComponent.plist"),
      "utf8",
    );
    expect(componentPlist).toContain("Applications/My Remote Codex.app");
    expect(componentPlist).toMatch(/<key>BundleIsRelocatable<\/key>\s*<false\/>/);
  });
});
