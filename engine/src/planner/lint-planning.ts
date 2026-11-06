import { attributeEffectiveLintIssue } from "@lando/landofile/lint";
import { type ConfigLintViolation, type ValidationIssue, parseValidationIssuePath } from "@lando/sdk/schema";
import type { AppPlannerError } from "@lando/sdk/services";
import { Match } from "effect";
import type { ResolvedLandofile } from "./event-set.ts";
import { configExpressionIssuePath } from "./landofile-scopes.ts";
import { capabilityPath } from "./lint-capabilities.ts";

export const planningLintFindings = (
  resolution: ResolvedLandofile,
  error: AppPlannerError,
): readonly ConfigLintViolation[] => {
  const landofile = resolution.landofile;
  const finding = (issue: ValidationIssue & { readonly rule: ConfigLintViolation["rule"] }) => [
    attributeEffectiveLintIssue(landofile, issue),
  ];
  const details = { message: error.message, suggestion: error.remediation };
  return Match.value(error).pipe(
    Match.tag("LandofileValidationError", (failure) =>
      failure.issues.length === 0
        ? finding({ ...details, rule: "landofile.validation", path: [] })
        : failure.issues.map((issue) =>
            attributeEffectiveLintIssue(landofile, { ...issue, rule: issue.rule ?? "landofile.validation" }),
          ),
    ),
    Match.tag("HealthcheckTargetUnsupportedError", (failure) => {
      const role = failure.role ?? "healthcheck";
      return finding({ ...details, rule: `landofile.${role}`, path: ["services", failure.service, role] });
    }),
    Match.tag("FileSyncSelectionError", () =>
      finding({ ...details, rule: "landofile.capability", path: [] }),
    ),
    Match.tag("RouteInputError", (failure) =>
      finding({ ...details, rule: "landofile.route", path: parseValidationIssuePath(failure.key) ?? [] }),
    ),
    Match.tag("RouteProviderMismatchError", () =>
      finding({ ...details, rule: "landofile.route", path: ["provider"] }),
    ),
    Match.tag("CapabilityError", (failure) =>
      finding({
        ...details,
        rule: "landofile.capability",
        path: capabilityPath(failure, resolution),
      }),
    ),
    Match.tag("NotImplementedError", () => finding({ ...details, rule: "landofile.validation", path: [] })),
    Match.tag("PublicationUnsupportedError", (failure) =>
      finding({ ...details, rule: "landofile.capability", path: ["services", failure.service, "endpoints"] }),
    ),
    Match.tag("DataTreeOwnershipCapabilityError", (failure) =>
      finding({ ...details, rule: "landofile.capability", path: failure.option.split(".") }),
    ),
    Match.tag("ConfigExpressionError", (failure) =>
      finding({ ...details, rule: "landofile.expression", path: configExpressionIssuePath(failure) }),
    ),
    Match.exhaustive,
  );
};
