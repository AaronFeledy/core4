import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  commandToShell,
  crontabInstallCommand,
  crontabLine,
  everyToSupercronicSchedule,
  posixQuote,
  supercronicInstallCommand,
} from "../src/crontab.ts";
import { SUPERCRONIC_ARTIFACTS, SUPERCRONIC_CRONTAB, SUPERCRONIC_VERSION } from "../src/supercronic.ts";

const shellCheck = (script: string): number => {
  const dir = mkdtempSync(join(tmpdir(), "schedule-sh-n-"));
  const path = join(dir, "script.sh");
  writeFileSync(path, script);
  try {
    return Bun.spawnSync(["sh", "-n", path], { stdout: "pipe", stderr: "pipe" }).exitCode;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("schedule crontab lines", () => {
  test("a line is the compiled schedule followed by the job command, with no privilege wrapper", () => {
    expect(crontabLine({ every: "@hourly", run: "true" })).toBe("@hourly true");
    expect(crontabLine({ every: "*/5 * * * *", run: ["php", "cron.php"] })).toBe(
      "*/5 * * * * 'php' 'cron.php'",
    );
    for (const user of ["root", "1001", "nobody", "www-data:staff"]) {
      const authored = { every: "@hourly", run: "true", user };
      const line = crontabLine(authored);
      expect(line, `${user} must not need a privilege wrapper`).not.toContain("setpriv");
      expect(line).toBe("@hourly true");
    }
  });

  test("argv commands are POSIX quoted", () => {
    expect(commandToShell(["echo", "it's fine"])).toBe("'echo' 'it'\\''s fine'");
    expect(posixQuote("plain")).toBe("'plain'");
  });

  test("translates @every into a supercronic crontab schedule", () => {
    expect(everyToSupercronicSchedule("@every 1s")).toBe("* * * * * * *");
    expect(everyToSupercronicSchedule("@every 5s")).toBe("*/5 * * * * * *");
    expect(everyToSupercronicSchedule("@every 30s")).toBe("*/30 * * * * * *");
    expect(everyToSupercronicSchedule("@every 1m")).toBe("* * * * *");
    expect(everyToSupercronicSchedule("@every 5m")).toBe("*/5 * * * *");
    expect(everyToSupercronicSchedule("@every 1h")).toBe("0 * * * *");
    expect(everyToSupercronicSchedule("@every 12h")).toBe("0 */12 * * *");
    expect(everyToSupercronicSchedule("@hourly")).toBe("@hourly");
    expect(everyToSupercronicSchedule("@every 1h30m")).toBeUndefined();
  });

  test("generated schedules never contain @every", () => {
    for (const every of ["@every 1s", "@every 30s", "@every 5m", "@every 1h", "@hourly", "0 0 * * *"]) {
      expect(crontabLine({ every, run: "true" })).not.toContain("@every");
    }
  });
});

describe("supercronic build scripts", () => {
  test("the binary step pins both architectures for the image architecture", () => {
    const script = supercronicInstallCommand();
    expect(script).toContain(SUPERCRONIC_VERSION);
    expect(script).toContain(SUPERCRONIC_ARTIFACTS.amd64.url);
    expect(script).toContain(SUPERCRONIC_ARTIFACTS.amd64.sha256);
    expect(script).toContain(SUPERCRONIC_ARTIFACTS.arm64.url);
    expect(script).toContain(SUPERCRONIC_ARTIFACTS.arm64.sha256);
    expect(script).toContain('case "$arch" in');
    expect(script).toContain("chmod 0755 /usr/local/bin/supercronic");
    expect(script.startsWith("set -eu\n")).toBe(true);
    expect(script).not.toContain("set -x");
    expect(script).not.toContain("setpriv");
    expect(script).not.toContain(SUPERCRONIC_CRONTAB);
  });

  test("the crontab step writes only the crontab and does not fetch the binary", () => {
    const script = crontabInstallCommand(["@hourly true", "*/5 * * * * 'php' 'cron.php'"]);
    expect(script.startsWith("set -eu\n")).toBe(true);
    expect(script).not.toContain("set -x");
    expect(script).not.toContain("setpriv");
    expect(script).not.toContain("aptible/supercronic");
    expect(script).not.toContain(SUPERCRONIC_VERSION);
    expect(script).toContain(`: > ${SUPERCRONIC_CRONTAB}`);
    expect(script).toContain(`printf '%s\\n' '@hourly true' >> ${SUPERCRONIC_CRONTAB}`);
    expect(script).toContain(`chmod 0644 ${SUPERCRONIC_CRONTAB}`);
  });

  test("both generated scripts are valid POSIX shell", () => {
    expect(shellCheck(supercronicInstallCommand())).toBe(0);
    expect(shellCheck(crontabInstallCommand(["@hourly true"]))).toBe(0);
    expect(shellCheck(crontabInstallCommand([]))).toBe(0);
  });
});
