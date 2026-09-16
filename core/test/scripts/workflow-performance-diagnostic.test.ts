import { describe, expect, test } from "bun:test";

import { setupFileSyncStatusFromStdout } from "../../../scripts/workflow-performance-diagnostic.ts";

const setupStdout = (input: { readonly ok: boolean; readonly fileSyncStatus?: string }): string =>
  JSON.stringify({
    apiVersion: "v4",
    command: "meta:setup",
    ok: input.ok,
    ...(input.ok
      ? {
          result: {
            providerId: "lando",
            installDir: "/opt/lando",
            fileSyncStatus: input.fileSyncStatus,
            networkCaInjectionConfigured: false,
          },
        }
      : { error: { _tag: "SetupStepFailedError", message: "setup failed" } }),
    warnings: [],
    deprecations: [],
  });

describe("workflow performance setup diagnostics", () => {
  test.each(["deferred", "installed", "satisfied", "unavailable"] as const)(
    "decodes the %s file-sync status from the setup result envelope",
    (fileSyncStatus) => {
      expect(setupFileSyncStatusFromStdout(setupStdout({ ok: true, fileSyncStatus }))).toBe(fileSyncStatus);
    },
  );

  test.each([setupStdout({ ok: false }), setupStdout({ ok: true }), "not-json"])(
    "rejects setup output without a successful typed result",
    (stdout) => {
      expect(setupFileSyncStatusFromStdout(stdout)).toBeUndefined();
    },
  );
});
