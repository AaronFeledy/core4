import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  SUPERCRONIC_BIN,
  SUPERCRONIC_CRONTAB,
  SUPERCRONIC_JOBS_DIRECTORY,
  SUPERCRONIC_VERSION,
} from "../src/supercronic.ts";

const productionPaths = {
  crontab: SUPERCRONIC_CRONTAB,
  jobsDirectory: SUPERCRONIC_JOBS_DIRECTORY,
  scheduler: SUPERCRONIC_BIN,
};
const utc = { service: "web", zone: "UTC" } as const;

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

/** Everything outside the script's single-quoted arguments. */
const outsideQuotes = (script: string): string =>
  script
    .split("'")
    .filter((_, index) => index % 2 === 0)
    .join("");

const tempPaths = (dir: string, scheduler: string) => ({
  crontab: join(dir, "crontab"),
  jobsDirectory: join(dir, "jobs"),
  scheduler,
});

const stubScheduler = (dir: string, exitCode: number): string => {
  const path = join(dir, "stub-supercronic");
  writeFileSync(path, `#!/bin/sh\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
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
    expect(everyToSupercronicSchedule("@every 24h")).toBe("0 0 * * *");
    expect(everyToSupercronicSchedule("@hourly")).toBe("@hourly");
    expect(everyToSupercronicSchedule("@every 1h30m")).toBeUndefined();
    expect(everyToSupercronicSchedule("@every 1500ms")).toBeUndefined();
    expect(everyToSupercronicSchedule("@every 1s1ns")).toBeUndefined();
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
      utc,
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
    expect(script).toContain(`'${SUPERCRONIC_BIN}' -test '${SUPERCRONIC_CRONTAB}'`);
  });

  test("the crontab always pins the zone as its first row", () => {
    const jobs = [{ name: "tick", every: "@hourly", run: "true" }];
    const chicago = crontabInstallCommand(jobs, productionPaths, {
      service: "web",
      zone: "America/Chicago",
    });
    expect(chicago).toContain(`printf '%s\\n' 'CRON_TZ=America/Chicago' >> ${SUPERCRONIC_CRONTAB}`);
    expect(chicago.indexOf("CRON_TZ=America/Chicago")).toBeLessThan(chicago.indexOf("jobs/tick"));
    const utcScript = crontabInstallCommand(jobs, productionPaths, utc);
    expect(utcScript).toContain(`printf '%s\\n' 'CRON_TZ=UTC' >> ${SUPERCRONIC_CRONTAB}`);
  });

  test("UTC skips the zone-data check, while a zone name is checked before anything is written", () => {
    const jobs = [{ name: "tick", every: "@hourly", run: "true" }];
    expect(crontabInstallCommand(jobs, productionPaths, utc)).not.toContain("zoneinfo");
    const berlin = crontabInstallCommand(jobs, productionPaths, { service: "web", zone: "Europe/Berlin" });
    expect(berlin.startsWith("set -eu\nif [ ! -e '/usr/share/zoneinfo/Europe/Berlin' ]; then\n")).toBe(true);
    expect(berlin).toContain("use TZ=Europe/Berlin");
    expect(berlin).toContain("run on UTC");
    expect(berlin).toContain("apk add --no-cache tzdata");
    expect(berlin).toContain("exit 1");
    expect(berlin).toContain(
      `mkdir -p ${SUPERCRONIC_CRONTAB.slice(0, SUPERCRONIC_CRONTAB.lastIndexOf("/"))}`,
    );
  });

  test("a POSIX rule string is refused and never reaches a path, a CRON_TZ line, or unquoted shell", () => {
    const value = "EST5EDT,M3.2.0,M11.1.0";
    const script = crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, {
      service: "web",
      zone: value,
    });
    expect(script).toContain("is not a timezone name");
    expect(script).toContain("Scheduled jobs need a zone name such as America/Chicago or UTC");
    expect(script).not.toContain("CRON_TZ=");
    expect(script).not.toContain("/usr/share/zoneinfo");
    expect(script.split("\n").filter((line) => line.includes("exit 1"))).toHaveLength(1);
    expect(outsideQuotes(script)).not.toContain(value);
  });

  test("the generated crontab step writes one script per job, the zone row, and one row per job", () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-crontab-step-"));
    const paths = tempPaths(dir, stubScheduler(dir, 0));
    const jobs = [
      { name: "nightly", every: "@daily", run: "cd /app\nphp artisan schedule:run" },
      { name: "argv", every: "@hourly", run: ["printf", "%s", "alpha\nbeta"] },
    ];
    const installer = join(dir, "install.sh");
    writeFileSync(installer, crontabInstallCommand(jobs, paths, utc));
    try {
      const install = Bun.spawnSync(["sh", installer], { stdout: "pipe", stderr: "pipe" });
      expect(install.exitCode, install.stderr.toString()).toBe(0);

      const rows = readFileSync(paths.crontab, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
      expect(rows).toEqual([
        "CRON_TZ=UTC",
        `@daily sh ${join(paths.jobsDirectory, "nightly")}`,
        `@hourly sh ${join(paths.jobsDirectory, "argv")}`,
      ]);
      expect(rows).toHaveLength(jobs.length + 1);

      expect(readFileSync(join(paths.jobsDirectory, "nightly"), "utf8")).toBe(
        "cd /app\nphp artisan schedule:run\n",
      );
      expect(readFileSync(join(paths.jobsDirectory, "argv"), "utf8")).toBe(
        "exec 'printf' '%s' 'alpha\nbeta'\n",
      );
      expect(statSync(join(paths.jobsDirectory, "nightly")).mode & 0o777).toBe(0o644);

      const listed = Bun.spawnSync(["sh", join(paths.jobsDirectory, "argv")], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toBe("alpha\nbeta");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(!existsSync("/usr/share/zoneinfo/America/Chicago"))(
    "a present zone file passes the guard and still pins the zone first",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "schedule-crontab-zone-"));
      const paths = tempPaths(dir, stubScheduler(dir, 0));
      const installer = join(dir, "install.sh");
      writeFileSync(
        installer,
        crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], paths, {
          service: "web",
          zone: "America/Chicago",
        }),
      );
      try {
        const install = Bun.spawnSync(["sh", installer], { stdout: "pipe", stderr: "pipe" });
        expect(install.exitCode, install.stderr.toString()).toBe(0);
        expect(readFileSync(paths.crontab, "utf8").split("\n")[0]).toBe("CRON_TZ=America/Chicago");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("a missing zone file exits 1 with the service and zone on stderr", () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-crontab-nozone-"));
    const paths = tempPaths(dir, stubScheduler(dir, 0));
    const installer = join(dir, "install.sh");
    writeFileSync(
      installer,
      crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], paths, {
        service: "web",
        zone: "Not/AZone",
      }),
    );
    try {
      const install = Bun.spawnSync(["sh", installer], { stdout: "pipe", stderr: "pipe" });
      expect(install.exitCode).toBe(1);
      expect(install.stderr.toString()).toContain("service web");
      expect(install.stderr.toString()).toContain("TZ=Not/AZone");
      expect(install.stderr.toString()).toContain("apk add --no-cache tzdata");
      expect(install.stderr.toString().trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a scheduler that rejects the crontab fails the step", () => {
    const dir = mkdtempSync(join(tmpdir(), "schedule-crontab-reject-"));
    const paths = tempPaths(dir, stubScheduler(dir, 1));
    const installer = join(dir, "install.sh");
    writeFileSync(
      installer,
      crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], paths, utc),
    );
    try {
      const install = Bun.spawnSync(["sh", installer], { stdout: "pipe", stderr: "pipe" });
      expect(install.exitCode).not.toBe(0);
      expect(install.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both generated scripts are valid POSIX shell", () => {
    expect(shellCheck(supercronicInstallCommand())).toBe(0);
    expect(
      shellCheck(
        crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, utc),
      ),
    ).toBe(0);
    expect(shellCheck(crontabInstallCommand([], productionPaths, utc))).toBe(0);
    expect(
      shellCheck(
        crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, {
          service: "web",
          zone: "America/Argentina/Buenos_Aires",
        }),
      ),
    ).toBe(0);
    expect(
      shellCheck(
        crontabInstallCommand([{ name: "tick", every: "@hourly", run: "true" }], productionPaths, {
          service: "web",
          zone: "EST5EDT,M3.2.0,M11.1.0",
        }),
      ),
    ).toBe(0);
  });
});
