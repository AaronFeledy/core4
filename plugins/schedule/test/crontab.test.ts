import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { crontabLine, everyToSupercronicSchedule, supercronicInstallCommand } from "../src/crontab.ts";
import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_VERSION } from "../src/supercronic.ts";

const linuxArch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : undefined;

const downloadPinnedSupercronic = async (dir: string): Promise<string> => {
  if (linuxArch === undefined) throw new Error("pinned supercronic ships linux amd64 and arm64 only");
  const artifact = SUPERCRONIC_ARTIFACTS[linuxArch];
  const path = join(dir, "supercronic");
  const response = await fetch(artifact.url);
  expect(response.ok, `download ${artifact.url}: ${response.status}`).toBe(true);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  expect(digest).toBe(artifact.sha256);
  writeFileSync(path, bytes);
  chmodSync(path, 0o755);
  return path;
};

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

  test("translates @every into a supercronic crontab schedule", () => {
    expect(everyToSupercronicSchedule("@every 1s")).toBe("* * * * * * *");
    expect(everyToSupercronicSchedule("@every 5s")).toBe("*/5 * * * * * *");
    expect(everyToSupercronicSchedule("@every 1m")).toBe("* * * * *");
    expect(everyToSupercronicSchedule("@every 5m")).toBe("*/5 * * * *");
    expect(everyToSupercronicSchedule("@every 1h")).toBe("0 * * * *");
    expect(everyToSupercronicSchedule("@hourly")).toBe("@hourly");
    expect(everyToSupercronicSchedule("@every 1h30m")).toBeUndefined();
    expect(
      crontabLine({ name: "tick", every: "@every 1s", run: "true" }, undefined).startsWith("* * * * * * * "),
    ).toBe(true);
  });

  test("pins the scheduler release in the install command", () => {
    const command = supercronicInstallCommand(["@hourly true"]);
    expect(command).toContain(SUPERCRONIC_VERSION);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.arm64.sha256);
    expect(command).toContain(SUPERCRONIC_ARTIFACTS.amd64.url);
    expect(command).toContain("apk add --no-cache setpriv");
    expect(command).toContain("grep -q -- --reuid");
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

  test.skipIf(process.platform !== "linux" || linuxArch === undefined)(
    "pinned supercronic -test accepts the generated crontab and rejects raw @every",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "schedule-supercronic-"));
      try {
        const bin = await downloadPinnedSupercronic(dir);
        const crontabDir = join(dir, "crontab");
        mkdirSync(crontabDir);
        const goodPath = join(crontabDir, "good");
        const badPath = join(crontabDir, "bad");
        writeFileSync(
          goodPath,
          `${crontabLine({ name: "tick", every: "@every 1s", run: "true" }, "1001")}\n${crontabLine({ name: "hourly", every: "@hourly", run: "true" }, undefined)}\n`,
        );
        writeFileSync(badPath, "@every 1s true\n");
        const good = Bun.spawnSync([bin, "-test", goodPath], { stdout: "pipe", stderr: "pipe" });
        expect(good.exitCode, new TextDecoder().decode(good.stderr)).toBe(0);
        const bad = Bun.spawnSync([bin, "-test", badPath], { stdout: "pipe", stderr: "pipe" });
        expect(bad.exitCode).not.toBe(0);
        expect(new TextDecoder().decode(bad.stderr) + new TextDecoder().decode(bad.stdout)).toMatch(
          /bad crontab line/iu,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
