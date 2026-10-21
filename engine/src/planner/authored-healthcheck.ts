import { getLandofileValueSource } from "@lando/landofile/validation";
import { LandofileValidationError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";

export const validateAuthoredHealthchecks = Effect.fnUntraced(function* (
  landofile: LandofileShape,
  file: string,
) {
  for (const [name, service] of Object.entries(landofile.services ?? {})) {
    const healthcheck = service.healthcheck;
    if (healthcheck === undefined || healthcheck === false) continue;
    switch (healthcheck.kind) {
      case "http":
      case "tcp": {
        const path = ["services", name, "healthcheck", "kind"];
        const source = getLandofileValueSource(landofile, path);
        const remediation =
          "Use kind: command with an in-container probe command, or healthcheck: false to disable the probe.";
        const message = `Authored healthcheck kind ${healthcheck.kind} is not supported by the healthcheck runner.`;
        return yield* Effect.fail(
          new LandofileValidationError({
            message,
            remediation,
            file: source?.file ?? file,
            issues: [{ path, message, suggestion: remediation, ...(source === undefined ? {} : { source }) }],
          }),
        );
      }
      case "command":
      case undefined:
        break;
    }
  }
});
