import { describe, expect, test } from "bun:test";

import { GlobalAutoStartError, ProviderUnavailableError } from "@lando/core/errors";

import { formatBugReport } from "../../src/cli/bug-report.ts";
import { metaGlobalReconcileSpec } from "../../src/cli/command-specs/meta/global/reconcile.ts";

describe("issue 796 global autostart", () => {
  test("configuration reconciliation has an explicit command that preserves saved policy", () => {
    expect(metaGlobalReconcileSpec.id).toBe("meta:global:reconcile");
    expect(metaGlobalReconcileSpec.topLevelAlias).toBe("global:reconcile");
  });

  test("auto-start failure report prints the cause and never says start Traefik by hand", () => {
    const text = formatBugReport({
      additionalErrors: [],
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
          remediation: "Install or start the `docker` provider and confirm it can perform `docker-api`.",
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
