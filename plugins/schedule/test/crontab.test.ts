import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ScheduleJob } from "@lando/sdk/schema";

import {
  commandToShell,
  crontabInstallCommand,
  crontabLine,
  everyToSupercronicSchedule,
  posixQuote,
  supercronicInstallCommand,
} from "../src/crontab.ts";
import {
  SUPERCRONIC_ARTIFACTS,
  SUPERCRONIC_CRONTAB,
  SUPERCRONIC_JOBS_DIRECTORY,
  SUPERCRONIC_VERSION,
} from "../src/supercronic.ts";

const productionPaths = { crontab: SUPERCRONIC_CRONTAB, jobsDirectory: SUPERCRONIC_JOBS_DIRECTORY };

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
  test("a line is the compiled schedule followed by the job script, with no privilege wrapper", () => {
    expect(crontabLine({ every: "@hourly", name: "tick" }, SUPERCRONIC_JOBS_DIRECTORY)).toBe(
      "@hourly sh /usr/local/etc/supercronic/jobs/tick",
    );
    expect(crontabLine({ every: "*/5 * * * *", name: "cron" }, SUPERCRONIC_JOBS_DIRECTORY)).toBe(
      "*/5 * * * * sh /usr/local/etc/supercronic/jobs/cron",
    );
    for (const user of ["root", "1001", "nobody", "www-data:staff"]) {
      const authored: ScheduleJob = { name: "tick", every: "@hourly", run: "true", user };
      const line = crontabLine(authored, SUPERCRONIC_JOBS_DIRECTORY);
      expect(line, `${user} must not need a privilege wrapper`).not.toContain("setpriv");
      expect(line).toBe("@hourly sh /usr/local/etc/supercronic/jobs/tick");
    }
  });

  test("a command with embedded newlines stays one crontab row per job", () => {
    const jobs = [
      { name: "nightly", every: "@daily", run: "cd /app\nphp artisan schedule:run" },
      { name: "argv", every: "@hourly", run: ["printf", "%s", "alpha\nbeta"] },
    ] as const;
    const lines = jobs.map((job) => crontabLine(job, SUPERCRONIC_JOBS_DIRECTORY));
    expect(lines).toEqual([
      "@daily sh /usr/local/etc/supercronic/jobs/nightly",
      "@hourly sh /usr/local/etc/supercronic/jobs/argv",
    ]);
    expect(lines.join("\n").split("\n")).toHaveLength(jobs.length);
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
      expect(crontabLine({ every, name: "tick" }, SUPERCRONIC_JOBS_DIRECTORY)).not.toContain("@every");
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

  test("the crontab step writes one script per job and does not fetch the binary", () => {
    const script = crontabInstallCommand(
      [
        { name: "tick", every: "@hourly", run: "true" },
        { name: "cron", every: "*/5 * * * *", run: ["php", "cron.php"] },
      ],
      productionPaths,
    );
    expect(script.startsWith("set -eu\n")).toBe(true);
    expect(script).not.toContain("set -x");
    expect(script).not.toContain("setpriv");
    expect(script).not.toContain("aptible/supercronic");
    expect(script).not.toContain(SUPERCRONIC_VERSION);
    expect(script).toContain(`: > ${SUPERCRONIC_CRONTAB}`);
    expect(script).toContain(
      `printf '%s\\n' '@hourly sh ${SUPERCRONIC_JOBS_DIRECTORY}/tick' >> ${SUPERCRONIC_CRONTAB}`,
    );
    expect(script).toContain(`> '${SUPERCRONIC_JOBS_DIRECTORY}/tick'`);
    expect(script).toContain(`chmod 0644 '${SUPERCRONIC_JOBS_DIRECTORY}/tick'`);
    expect(script).toContain(`chmod 0644 ${SUPERCRONIC_CRONTAB}`);
  });

  test("guards the crontab step on the parent service timezone when given one", () => {
    const script = crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, {
      service: "web",
      zone: "Europe/Berlin",
    });
    expect(script.startsWith("set -eu\nif [ ! -e '/usr/share/zoneinfo/Europe/Berlin' ]; then\n")).toBe(true);
    expect(script).toContain("use TZ=Europe/Berlin");
    expect(script).toContain("run on UTC");
    expect(script).toContain("apk add --no-cache tzdata");
    expect(script).toContain("exit 1");
    expect(script).toContain(
      `mkdir -p ${SUPERCRONIC_CRONTAB.slice(0, SUPERCRONIC_CRONTAB.lastIndexOf("/"))}`,
    );
  });

  test("the generated crontab step writes one script per job and one crontab row per job", () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-crontab-step-"));
    const crontab = join(dir, "crontab");
    const jobsDirectory = join(dir, "jobs");
    const jobs = [
      { name: "nightly", every: "@daily", run: "cd /app\nphp artisan schedule:run" },
      { name: "argv", every: "@hourly", run: ["printf", "%s", "alpha\nbeta"] },
    ];
    const installer = join(dir, "install.sh");
    writeFileSync(installer, crontabInstallCommand(jobs, { crontab, jobsDirectory }));
    try {
      const install = Bun.spawnSync(["sh", installer], { stdout: "pipe", stderr: "pipe" });
      expect(install.exitCode, install.stderr.toString()).toBe(0);

      const rows = readFileSync(crontab, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(rows).toEqual([
        `@daily sh ${join(jobsDirectory, "nightly")}`,
        `@hourly sh ${join(jobsDirectory, "argv")}`,
      ]);
      expect(rows).toHaveLength(jobs.length);

      expect(readFileSync(join(jobsDirectory, "nightly"), "utf8")).toBe(
        "cd /app\nphp artisan schedule:run\n",
      );
      expect(readFileSync(join(jobsDirectory, "argv"), "utf8")).toBe("exec 'printf' '%s' 'alpha\nbeta'\n");
      expect(statSync(join(jobsDirectory, "nightly")).mode & 0o777).toBe(0o644);

      const listed = Bun.spawnSync(["sh", join(jobsDirectory, "argv")], { stdout: "pipe", stderr: "pipe" });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toBe("alpha\nbeta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both generated scripts are valid POSIX shell", () => {
    expect(shellCheck(supercronicInstallCommand())).toBe(0);
    expect(
      shellCheck(crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths)),
    ).toBe(0);
    expect(shellCheck(crontabInstallCommand([], productionPaths))).toBe(0);
    expect(
      shellCheck(
        crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, {
          service: "web",
          zone: "America/Argentina/Buenos_Aires",
        }),
      ),
    ).toBe(0);
  });
});
