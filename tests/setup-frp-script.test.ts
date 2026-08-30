import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const script = path.resolve("scripts/setup-frp.sh");

describe("FRP setup script", () => {
  it("has valid Bash syntax", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });

  it("documents the server, local, download, start, and status commands", () => {
    const output = execFileSync("bash", [script, "--help"], { encoding: "utf8" });
    expect(output).toContain("server");
    expect(output).toContain("local");
    expect(output).toContain("download");
    expect(output).toContain("start");
    expect(output).toContain("status");
  });

  it("rejects unknown commands without changing the host", () => {
    const result = spawnSync("bash", [script, "unknown"], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown command");
  });

  it("allows installer builds to select a target macOS architecture", () => {
    const source = fs.readFileSync(script, "utf8");
    expect(source).toContain('--os) target_os=');
    expect(source).toContain('--arch) target_arch=');
    expect(source).toContain('install_frp_binary "$binary_name" "$output" "$target_os" "$target_arch"');
    expect(source).toContain(
      'https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${extracted}.tar.gz',
    );
    expect(source).not.toContain("https://api.github.com/repos/fatedier/frp/releases/assets/");
  });
});
