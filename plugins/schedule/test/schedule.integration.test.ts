import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RunEnvelope,
  cells,
  decodeLastLine,
  expectSuccess,
  infoFor,
  landofile,
  reserveLoopbackPort,
  runCli,
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

          // 1. Start the app; the parent runs as 1001 and jobs split into sidecars by user.
          expectSuccess(
            await runCli(cell, appRoot, ["start", "--format=json"], 600_000),
            `lando start on ${cell.label} (${image})`,
          );

          // 2. Jobs run natively as their own identity, including a named user whose group differs.
          const scheduledUid = await waitForText(
            join(appRoot, "scheduled-uid.txt"),
            90_000,
            "the inherited-user job",
          );
          expect(scheduledUid.trim(), "the no-user job must run as the parent uid").toBe("1001");

          const otherUid = await waitForText(join(appRoot, "other-uid.txt"), 90_000, "the 1002 job");
          expect(otherUid.trim(), "the user: 1002 job must run as 1002").toBe("1002");

          if (image === "php:8.3") {
            const nobodyUid = await waitForText(join(appRoot, "nobody-uid.txt"), 90_000, "the nobody job");
            expect(nobodyUid.trim(), "a named user with a different group must still run").toBe("65534");
          }

          const parentHome = async (user: string): Promise<string> => {
            const result = expectSuccess(
              await runCli(cell, appRoot, ["exec", "--user", user, "web", "--", "sh", "-c", "echo $HOME"]),
              `lando exec --user ${user} web`,
            );
            return result.stdout.trim();
          };

          const inheritedHome = await waitForText(
            join(appRoot, "scheduled-home.txt"),
            30_000,
            "the inherited-user HOME",
          );
          expect(inheritedHome.trim(), "the inherited job HOME must match the parent identity").toBe(
            await parentHome("1001"),
          );
          const otherHome = await waitForText(join(appRoot, "other-home.txt"), 30_000, "the 1002 HOME");
          expect(otherHome.trim(), "the user: 1002 job HOME must match that identity").toBe(
            await parentHome("1002"),
          );
          if (image === "php:8.3") {
            const nobodyHome = await waitForText(join(appRoot, "nobody-home.txt"), 30_000, "the nobody HOME");
            expect(nobodyHome.trim(), "the nobody job HOME must match that identity").toBe(
              await parentHome("nobody"),
            );
          }

          // 3. A shadowed app path is shared with the sidecars.
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

          // 4. Sidecars have no endpoints or host publications; only the parent holds the fixed port.
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

          // 5. The pinned binary accepts the generated crontab in every sidecar.
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

          // 6. schedule:run returns the completed result for success and for a nonzero exit.
          const yearly = expectSuccess(
            await runCli(cell, appRoot, ["schedule:run", "yearly", "--format=json"]),
            "lando schedule:run yearly",
          );
          const yearlyEnvelope = decodeLastLine(RunEnvelope, yearly.stdout, "schedule:run yearly");
          expect(yearlyEnvelope.ok).toBe(true);
          expect(yearlyEnvelope.result.service).toBe("web");
          expect(yearlyEnvelope.result.exitCode).toBe(0);
          expect(yearlyEnvelope.result.stdout).toContain("yearly-ran");

          const failing = await runCli(cell, appRoot, ["schedule:run", "failing", "--format=json"]);
          expect(failing.exitCode, `failing job should exit 3\n${failing.stdout}\n${failing.stderr}`).toBe(3);
          const failingEnvelope = decodeLastLine(RunEnvelope, failing.stdout, "schedule:run failing");
          expect(failingEnvelope.ok).toBe(false);
          expect(failingEnvelope.result.exitCode).toBe(3);
          expect(failingEnvelope.result.stdout, "the failed result must retain stdout").toContain(
            "failing-stdout",
          );
          expect(failingEnvelope.error?.exitCode).toBe(3);

          // 7. Editing a job updates only the crontab layer; the scheduler download stays cached.
          await writeFile(join(appRoot, ".lando.yml"), landofile({ appName, image, port, mode: "edited" }));
          const restart = expectSuccess(
            await runCli(cell, appRoot, ["restart"], 600_000),
            `lando restart after editing a job on ${cell.label}`,
          );
          await waitForText(join(appRoot, "restarted.txt"), 90_000, "the edited job to run");
          expect(
            restart.stdout + restart.stderr,
            "restart must not download supercronic again when only the crontab changed",
          ).not.toContain("aptible/supercronic");

          // 8. Removing schedule: removes every sidecar.
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
          // 9. Always tear the app and its volumes down.
          await runCli(cell, appRoot, ["destroy", "-y", "--volumes"], 180_000);
          await rm(appRoot, { recursive: true, force: true });
        }
      },
      900_000,
    );
  }
}
