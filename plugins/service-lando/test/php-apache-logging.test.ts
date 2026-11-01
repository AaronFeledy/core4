import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import { php83ServiceType } from "../src/services/php.ts";
import { apacheLauncherDirectives } from "./support/apache-directives.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const Steps = Schema.Struct({
  buildSteps: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      user: Schema.optionalKey(Schema.String),
      command: Schema.Unknown,
    }),
  ),
});
const compose = (input: Readonly<Record<string, unknown>>) =>
  composeServicePlan({
    serviceType: php83ServiceType,
    service: Schema.decodeUnknownSync(ServiceConfig)({ type: "php:8.3", home: false, ...input }),
    appRoot: "/srv/apps/php-logging",
    appName: "php-logging",
    serviceName: "web",
    metadata: { resolvedAt: "2026-10-28T00:00:00Z", source: "php-logging", runtime: 4 },
  });

describe("owned PHP Apache log streams", () => {
  test.skipIf(process.platform === "win32")(
    "keeps inherited stderr distinct when Apache redirects its logger stderr to stdout",
    async () => {
      // Given: a launcher probe emulating Apache's piped-logger stderr reassignment.
      const plan = await compose({ user: "www-data" });
      const directory = await mkdtemp(join(tmpdir(), "lando-apache-fd-"));
      try {
        const executable = join(directory, "apache2-foreground");
        await Bun.write(
          executable,
          "#!/bin/sh\nexec 2>&1\nprintf 'access\\n'\nprintf 'error\\n' | /bin/sh -c 'exec /bin/cat >&3'\n",
        );
        await chmod(executable, 0o755);
        if (!Array.isArray(plan.command)) throw new Error("expected launcher argv");
        // When: execute the generated launcher through its real shell/exec chain.
        const result = Bun.spawnSync(plan.command, {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
          stdout: "pipe",
          stderr: "pipe",
        });
        // Then: the saved descriptor bypasses the reassigned stderr.
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe("access\n");
        expect(result.stderr.toString()).toBe("error\n");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  for (const user of [undefined, "root", "www-data"]) {
    for (const port of [undefined, 80, 8080]) {
      test(`preserves global stdout/stderr routing for user=${user}, port=${port}`, async () => {
        // Given / When: root and non-root launches, with main-server and virtual-host shapes.
        const plan = await compose({
          ...(user === undefined ? {} : { user }),
          ...(port === undefined ? {} : { port }),
        });
        // Then: logging is global so both main and generated virtual hosts inherit it.
        const directives = apacheLauncherDirectives(plan.command, "apache2-foreground");
        const logs = directives.filter((line) => /^(ErrorLog|CustomLog) /u.test(line));
        expect(logs).toEqual([
          `ErrorLog "|/bin/sh -c 'exec /bin/cat >&3'"`,
          'CustomLog "|/bin/cat" vhost_combined',
        ]);
        if (port !== undefined) {
          expect(directives.indexOf(logs[0] ?? "")).toBeLessThan(
            directives.indexOf(`<VirtualHost *:${port}>`),
          );
        }
        expect(plan.command?.slice(0, 2)).toEqual(["sh", "-c"]);
        const script = plan.command?.[2] ?? "";
        expect(script).toContain("exec 3>&2");
        expect(script.indexOf("exec 3>&2")).toBeLessThan(script.indexOf('exec apache2-foreground "$@"'));
        expect(script).not.toMatch(/>\s*\/|a2enmod|a2dissite/u);
        if (user !== undefined) expect(script).not.toMatch(/usermod|groupmod|stat -c/u);
        // Debian's additive CustomLog must not reopen its root-owned log file.
        const steps = Schema.decodeUnknownSync(Steps)(
          plan.extensions["@lando/core/service-features"],
        ).buildSteps;
        const preparation = steps.find(({ id }) => id === "service-lando.php:apache-default-site");
        expect(preparation?.user).toBe("root");
        expect(JSON.stringify(preparation?.command)).toContain("/etc/apache2/sites-enabled/000-default.conf");
        expect(JSON.stringify(preparation?.command)).toContain(
          "/etc/apache2/conf-enabled/other-vhosts-access-log.conf",
        );
      });
    }
  }

  test.each([
    { command: ["apache2-foreground"] },
    { entrypoint: ["/custom-start"] },
    { image: "example/php:custom" },
    { build: { context: "." }, image: "php:8.3-apache-bookworm" },
  ])("leaves authored Apache process and logging untouched for %j", async (input) => {
    // Given / When: Lando does not own the Apache process.
    const plan = await compose(input);
    // Then: no logging launcher or privileged Apache preparation is injected.
    expect(plan.command).toEqual(input.command);
    expect(plan.entrypoint).toEqual(input.entrypoint);
    const steps = Schema.decodeUnknownSync(Steps)(plan.extensions["@lando/core/service-features"]).buildSteps;
    expect(steps.some(({ id }) => id === "service-lando.php:apache-default-site")).toBe(false);
  });
});
