import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SUPERCRONIC_JOBS_DIRECTORY } from "../src/supercronic.ts";
import {
  RunEnvelope,
  cells,
  decodeLastLine,
  expectSuccess,
  infoFor,
  landofile,
  reserveLoopbackPort,
  runCli,
  scheduleZoneAbbreviations,
  sidecarNames,
  waitForText,
} from "./schedule-live-support.ts";

for (const cell of cells) {
  for (const image of ["php:8.3", "alpine:3.22"] as const) {
    const skip = cell.available ? "" : ` (SKIP: ${cell.missing} is not set)`;
    test.skipIf(!cell.available)(
      `scheduled jobs run with native identities and survive schedule edits on ${cell.label} (${image})${skip}`,
      async () => {
        const appRoot = await mkdtemp(join(tmpdir(), "lando-schedule-live-"));
        const appName = `sched${crypto.randomUUID().replace(/-/gu, "").slice(0, 10)}`;
        const port = reserveLoopbackPort();
        const expectedSidecars = sidecarNames(image);
        try {
          await chmod(appRoot, 0o777);
          await writeFile(join(appRoot, ".lando.yml"), landofile({ appName, image, port, mode: "full" }));

          expectSuccess(
            await runCli(cell, appRoot, ["start", "--format=json"], 600_000),
            `lando start on ${cell.label} (${image})`,
          );

          const timerIdentity = async (job: string, prefix: string) => {
            const values = await Promise.all(
              ["uid", "gid", "home", "pwd", "tz"].map((field) =>
                waitForText(join(appRoot, `${prefix}-${field}.txt`), 90_000, `the ${job} job ${field}`),
              ),
            );
            return values.map((value) => value.trim());
          };

          const runIdentity = async (job: string) => {
            const run = expectSuccess(
              await runCli(cell, appRoot, ["schedule:run", job, "--format=json"]),
              `lando schedule:run ${job} on ${cell.label} (${image})`,
            );
            const envelope = decodeLastLine(RunEnvelope, run.stdout, `schedule:run ${job}`);
            expect(envelope.ok, `schedule:run ${job} must succeed`).toBe(true);
            return envelope.result.stdout.trim().split("\n");
          };

          const inherited = await timerIdentity("tick", "scheduled");
          expect(inherited[0], "the no-user job must run as the parent uid").toBe("1001");
          const zone = await waitForText(join(appRoot, "scheduled-tz.txt"), 90_000, "the tick job zone");
          expect(
            scheduleZoneAbbreviations(image),
            `the scheduler must run jobs in the service TZ, not the image default: ${zone.trim()}`,
          ).toContain(zone.trim());
          expect(
            await runIdentity("tick"),
            "schedule:run must report the identity the timer used for the no-user job",
          ).toEqual(inherited);

          const other = await timerIdentity("second", "other");
          expect(other[0], "the user: 1002 job must run as 1002").toBe("1002");
          expect(
            await runIdentity("second"),
            "schedule:run must report the identity the timer used for the 1002 job",
          ).toEqual(other);

          if (image === "php:8.3") {
            const nobody = await timerIdentity("named", "nobody");
            expect(nobody[0], "a named user with a different group must still run as 65534").toBe("65534");
            expect(nobody[1], "nobody must run in group nogroup (65534)").toBe("65534");
            expect(
              await runIdentity("named"),
              "schedule:run must report the identity the timer used for the nobody job",
            ).toEqual(nobody);
          }

          const marker = `vendor-${crypto.randomUUID()}`;
          expectSuccess(
            await runCli(cell, appRoot, [
              "exec",
              "--user",
              "root",
              "web",
              "--",
              "sh",
              "-c",
              `mkdir -p /app/vendor && printf '%s' '${marker}' > /app/vendor/marker`,
            ]),
            "writing the parent vendor marker",
          );
          const seen = await waitForText(join(appRoot, "vendor-seen.txt"), 120_000, "the vendor marker job");
          expect(seen, "the sidecar must see the parent's shadowed /app/vendor contents").toBe(marker);

          const services = await infoFor(cell, appRoot);
          const byName = new Map(services.map((service) => [service.service, service]));
          const parent = byName.get("web");
          expect(parent, "lando info must list the parent service").toBeDefined();
          const parentHostConnections = (parent?.connections ?? []).filter(
            (connection) => connection.scope === "host",
          );
          expect(
            parentHostConnections.map((connection) => connection.port),
            "the parent must publish the authored loopback port",
          ).toContain(port);
          expect(
            services
              .map((service) => service.service)
              .filter((name) => name.includes("-schedule"))
              .sort(),
            `lando info must list exactly the expected sidecars: ${expectedSidecars.join(", ")}`,
          ).toEqual([...expectedSidecars].sort());
          for (const name of expectedSidecars) {
            const sidecar = byName.get(name);
            expect(sidecar, `lando info must list the ${name} sidecar`).toBeDefined();
            expect(
              (sidecar?.connections ?? []).filter((connection) => connection.scope === "host"),
              `${name} must not publish a host endpoint`,
            ).toEqual([]);
          }
          expect(byName.get("web-schedule")?.user, "the first group must keep the parent user").toBe("1001");
          expect(byName.get("web-schedule-1002")?.user, "the 1002 group must keep its user").toBe("1002");
          if (image === "php:8.3") {
            expect(byName.get("web-schedule-nobody")?.user, "the nobody group must keep its user").toBe(
              "nobody",
            );
          }

          for (const name of expectedSidecars) {
            expectSuccess(
              await runCli(cell, appRoot, [
                "exec",
                name,
                "--",
                "/usr/local/bin/supercronic",
                "-test",
                "/usr/local/etc/supercronic/crontab",
              ]),
              `supercronic -test in ${name}`,
            );
          }

          const yearly = expectSuccess(
            await runCli(cell, appRoot, ["schedule:run", "yearly", "--format=json"]),
            "lando schedule:run yearly",
          );
          const yearlyEnvelope = decodeLastLine(RunEnvelope, yearly.stdout, "schedule:run yearly");
          expect(yearlyEnvelope.ok, "schedule:run yearly must report success").toBe(true);
          expect(yearlyEnvelope.result.service, "the yearly result must identify its parent service").toBe(
            "web",
          );
          expect(yearlyEnvelope.result.exitCode, "the yearly job must exit successfully").toBe(0);
          expect(yearlyEnvelope.result.stdout, "the yearly result must retain job stdout").toContain(
            "yearly-ran",
          );

          const failing = await runCli(cell, appRoot, ["schedule:run", "failing", "--format=json"]);
          expect(failing.exitCode, `failing job should exit 3\n${failing.stdout}\n${failing.stderr}`).toBe(3);
          const failingEnvelope = decodeLastLine(RunEnvelope, failing.stdout, "schedule:run failing");
          expect(failingEnvelope.ok, "schedule:run failing must report failure").toBe(false);
          expect(failingEnvelope.result.exitCode, "the failed result must retain exit code 3").toBe(3);
          expect(failingEnvelope.result.stdout, "the failed result must retain stdout").toContain(
            "failing-stdout",
          );
          expect(failingEnvelope.error?.exitCode, "the error envelope must retain the job exit code").toBe(3);

          await writeFile(join(appRoot, ".lando.yml"), landofile({ appName, image, port, mode: "edited" }));
          expectSuccess(
            await runCli(cell, appRoot, ["restart"], 600_000),
            `lando restart after editing a job on ${cell.label}`,
          );
          await waitForText(join(appRoot, "restarted.txt"), 90_000, "the edited job to run");
          const script = expectSuccess(
            await runCli(cell, appRoot, [
              "exec",
              "web-schedule",
              "--",
              "cat",
              `${SUPERCRONIC_JOBS_DIRECTORY}/tick`,
            ]),
            `reading the restarted web-schedule tick script on ${cell.label} (${image})`,
          );
          expect(
            script.stdout,
            "the restarted sidecar tick script must contain the edited job command",
          ).toContain("restarted.txt");
          expect(
            script.stdout,
            "the edited job command must replace the previous tick command",
          ).not.toContain("scheduled.txt");

          await writeFile(join(appRoot, ".lando.yml"), landofile({ appName, image, port, mode: "none" }));
          expectSuccess(
            await runCli(cell, appRoot, ["restart"], 600_000),
            `lando restart after removing schedule: on ${cell.label}`,
          );
          const remaining = await infoFor(cell, appRoot);
          expect(
            remaining.map((service) => service.service).filter((name) => name.includes("-schedule")),
            "removing schedule: must remove every sidecar service",
          ).toEqual([]);
        } finally {
          await runCli(cell, appRoot, ["destroy", "-y", "--volumes"], 180_000);
          await rm(appRoot, { recursive: true, force: true });
        }
      },
      900_000,
    );
  }
}
