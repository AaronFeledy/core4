import { LandofileValidationError } from "@lando/sdk/errors";
import { type ServiceConfig, validationIssue } from "@lando/sdk/schema";
import type { FeatureRef } from "@lando/sdk/services";
import { Effect } from "effect";

export const validateAuthoredWebroot = Effect.fn("AppPlanner.validateAuthoredWebroot")(function* (
  service: { readonly name: string; readonly authoredService: ServiceConfig },
  featureRefs: readonly FeatureRef[],
  landofilePath: string,
) {
  if (service.authoredService.webroot === undefined) return;
  if (featureRefs.some((ref) => typeof ref.config?.webroot === "string" && ref.config.webroot.length > 0))
    return;
  const remediation =
    service.authoredService.appMount === false
      ? "Remove webroot, enable appMount for mount-based webroot context, or select a supporting feature that declares and handles the effective webroot without an app mount."
      : "Remove webroot or select a supporting feature that declares and handles the effective webroot.";
  const message = `Service ${service.name} has an explicit webroot, but no composed feature declares support for it. ${remediation}`;
  return yield* Effect.fail(
    new LandofileValidationError({
      file: landofilePath,
      message,
      issues: [validationIssue(["services", service.name, "webroot"], message)],
    }),
  );
});
