import { describe, expect, test } from "bun:test";
import { AppIdReservedError } from "@lando/sdk/errors";
import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report";

const context = { commandId: "app:start", cacheRoot: "/tmp/lando-cache" };
const failure = { message: "The operation failed.", remediation: "Correct the configuration, then run lando start." };
const logTail = { service: "web", lines: ["Starting web", "Address already in use"], exitCode: 1, truncated: true };

// These inputs exercise every former tag-specific presentation branch.
export const diagnosticGoldenErrors = [
  new AppIdReservedError({ reserved: "global", suggested: "my-app" }),
  { ...failure, _tag: "LandofileParseError", filePath: "/app/.lando.yml", line: 3 },
  { ...failure, _tag: "SqlDumpNotFoundError", path: "data.sql", appRoot: "/app" },
  { ...failure, _tag: "DataTransferError", fromEndpoint: "database:dump" },
  { ...failure, _tag: "RendererSelectionError", value: "missing", source: "flag" },
  { ...failure, _tag: "RecipePromptValidationError", promptName: "name" },
  { ...failure, _tag: "UpdateLaunchProbeError", platform: "linux-x64", attemptedVersion: "4.0.0", probeCommand: "lando version", outputSummary: "Launch failed", rollbackFailure: "Permission denied", exitCode: 1 },
  { ...failure, _tag: "ServiceStartError", service: "web", logTail },
  { ...failure, _tag: "ServiceNotReadyError", service: "web", logTail },
  { ...failure, _tag: "ServiceExecError", service: "web" },
  { ...failure, _tag: "ServiceNotFoundError", service: "web" },
  { ...failure, _tag: "CapabilityError", service: "web", key: "shm_size", capability: "composeSpec" },
  { ...failure, _tag: "LandofileEventStepFailedError", event: "pre-start", index: 0, kind: "command", service: "web", outputTail: "Unknown command app:confgi" },
  { ...failure, _tag: "ComposeKeyRejectedError", source: "compose", service: "web", keyPath: "deploy.replicas" },
  { ...failure, _tag: "RecipePostInitError", recipe: "drupal", exitCode: 1 },
];

describe("human diagnostic goldens", () => {
  for (const error of diagnosticGoldenErrors) {
    test(`renders ${error._tag} with actionable context`, () => {
      // Given: a failure carrying the fields handled by the original renderer.
      // When
      const output = renderPlainBugReport(buildBugReport({ error, context }));
      // Then: capture the real pre-refactor output before changing presentation.
      expect(output).toMatchSnapshot();
    });
  }
});
