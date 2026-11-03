import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crontabLine, supercronicInstallCommand } from "../src/crontab.ts";
import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_VERSION } from "../src/supercronic.ts";

describe("schedule crontab", () => {
  test("drops to the parent user and a different numeric or named job user", () => {
    expect(crontabLine({ name: "tick", every: "@hourly", run: "true" }, "1001")).toContain(
      "setpriv --reuid=1001 --clear-groups",
    );
    expect(crontabLine({ name: "tick", every: "@hourly", run: "true", user: "1002" }, "1001")).toContain(
      "setpriv --reuid=1002 --clear-groups",
    );
    expect(crontabLine({ name: "tick", every: "@hourly", run: "true", user: "www-data" }, "1001")).toContain(
      "setpriv --reuid='www-data' --regid='www-data' --init-groups",
    );
  });

  test("pins the scheduler release in the install command", () => {
    const command = supercronicInstallCommand(["@hourly true"]);
    expect(command).toContain(SUPERCRONIC_VERSION);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.arm64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.url);
  });

  test("generated install script is valid POSIX shell", () => {
    const script = supercronicInstallCommand(["@hourly true"]);
    expect(script).toContain('case "$arch" in\n');
    expect(script).not.toContain("in &&");
    const dir = mkdtempSync(join(tmpdir(), "schedule-sh-n-"));
    const path = join(dir, "install.sh");
    writeFileSync(path, script);
    try {
      const result = Bun.spawnSync(["sh", "-n", path], { stdout: "pipe", stderr: "pipe" });
      expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
