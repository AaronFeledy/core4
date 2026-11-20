import { attributeEffectiveLintIssue, attributeLintIssue } from "@lando/landofile/lint";
import { getExactLandofileValueSource } from "@lando/landofile/validation";
import type { ConfigLintViolation, ValidationIssue } from "@lando/sdk/schema";
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
    attributeEffectiveLintIssue(landofile, issue, resolution.provenance),
  ];
  const details = { message: error.message, suggestion: error.remediation };
  const locatedFinding = (issue: ValidationIssue & { readonly rule: ConfigLintViolation["rule"] }) =>
    attributeLintIssue(issue, "effective", resolution.provenance?.documents ?? []);
  return Match.value(error).pipe(
    Match.tag("AppDataIdentityError", () => finding({ ...details, rule: "landofile.validation", path: [] })),
    Match.tag("LandofileValidationError", (failure) =>
      failure.issues.length === 0
        ? [locatedFinding({ ...details, rule: "landofile.validation", path: [] })]
        : failure.issues.map((issue) =>
            locatedFinding({ ...issue, rule: issue.rule ?? "landofile.validation" }),
          ),
    ),
    Match.tag("HealthcheckTargetUnsupportedError", (failure) => {
      const role = failure.role ?? "healthcheck";
      return finding({ ...details, rule: `landofile.${role}`, path: ["services", failure.service, role] });
    }),
    Match.tag("FileSyncSelectionError", () =>
      finding({ ...details, rule: "landofile.capability", path: [] }),
    ),
    Match.tag("RouteInputError", (failure) => {
      const source =
        failure.path.length === 0
          ? undefined
          : getExactLandofileValueSource(resolution.provenance, failure.path);
      return [
        locatedFinding({
          ...details,
          rule: "landofile.route",
          path: failure.path,
          ...(source !== undefined && source.file === failure.file ? { source } : {}),
        }),
      ];
    }),
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
      finding({
        ...details,
        rule: "landofile.capability",
        path: failure.path,
      }),
    ),
    Match.tag("ConfigExpressionError", (failure) => [
      locatedFinding({
        ...details,
        rule: "landofile.expression",
        path: configExpressionIssuePath(failure),
        ...(failure.source === undefined ? {} : { source: failure.source }),
      }),
    ]),
    Match.exhaustive,
  );
};
