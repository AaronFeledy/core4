import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { GlobalAutoStartError, ProviderUnavailableError } from "@lando/core/errors";

import { formatBugReport } from "../../src/cli/bug-report.ts";
import { metaGlobalInstallSpec } from "../../src/cli/command-specs/meta/global/install.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

describe("issue 796 global autostart", () => {
  test("global:install spec accepts --yes", () => {
    expect(metaGlobalInstallSpec.flags?.yes).toBeDefined();
    expect(metaGlobalInstallSpec.flags?.yes?.type).toBe("boolean");
  });

  test("CLI accepts global:install --yes without UnknownCliFlagError", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-796-yes-data-"));
    const confRoot = await mkdtemp(join(tmpdir(), "lando-796-yes-conf-"));
    try {
      const proc = Bun.spawn(["bun", cliEntry, "global:install", "--yes", "--format", "json"], {
        cwd: dataRoot,
        env: {
          ...process.env,
          LANDO_USER_DATA_ROOT: dataRoot,
          LANDO_USER_CONF_ROOT: confRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("UnknownCliFlagError");
      expect(combined).not.toContain("Unknown flag");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
      await rm(confRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("auto-start failure report prints the cause and never says start Traefik by hand", () => {
    const text = formatBugReport({
      error: new GlobalAutoStartError({
        message: "Failed to auto-start global services (traefik) required by my-drupal-cms-app.",
        app: "my-drupal-cms-app",
        services: ["traefik"],
        remediation:
          "Lando tried to install and start the required global services automatically. Fix the underlying error, then retry `lando start`.",
        cause: new ProviderUnavailableError({
          providerId: "docker",
          operation: "docker-api",
          message: "Docker API request failed with exit code 7.",
        }),
      }),
      context: { commandId: "app:start", cacheRoot: "/tmp/lando-test-cache" },
      rendererMode: "plain",
    });
    expect(text).toContain("Failed to auto-start global services (traefik) required by my-drupal-cms-app.");
    expect(text).toContain("Docker API request failed with exit code 7.");
    expect(text).toContain("providerId: docker");
    expect(text).toContain("cause: ProviderUnavailableError");
    expect(text).toContain("retry `lando start`");
    expect(text).not.toContain("Start the global app manually");
    expect(text).not.toContain("global:start");
    expect(text).not.toContain("Traefik manually");
  });
});
