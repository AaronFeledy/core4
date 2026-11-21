import { LandofileValidationError } from "@lando/sdk/errors";
import {
  type ExpressionTemplate,
  expressionScopeMemberPaths,
  expressionScopeMembers,
} from "@lando/sdk/expressions";

/** The only destination for a public route URL: a map-form service environment value. */
export const isServiceEnvironmentValuePath = (path: readonly (string | number)[]): boolean =>
  path.length === 4 &&
  path[0] === "services" &&
  typeof path[1] === "string" &&
  path[2] === "environment" &&
  typeof path[3] === "string";

export const ROUTE_URL_SITE_REMEDIATION =
  "Use {{ service.url }} for the current service or {{ services.<name>.url }} for a named service under services.<svc>.environment.<NAME> in map form, then have the process read $NAME from its environment.";

export const routeUrlSiteError = (
  template: ExpressionTemplate,
  source: NonNullable<LandofileValidationError["issues"]>[number]["source"],
): LandofileValidationError | undefined => {
  if (source === undefined || !("file" in source)) return undefined;
  const { path } = source;
  if (isServiceEnvironmentValuePath(path)) return undefined;
  const named = expressionScopeMemberPaths(template, "services").paths.find(([, member]) => member === "url");
  const self = expressionScopeMembers(template, "service").members.has("url");
  const reference = self ? "service.url" : named === undefined ? undefined : `services.${named[0]}.url`;
  if (reference === undefined) return undefined;
  const message = `${reference} is not supported at ${path.join(".")}.`;
  const suggestion = ROUTE_URL_SITE_REMEDIATION;
  return new LandofileValidationError({
    file: source.file,
    message,
    remediation: suggestion,
    issues: [{ path, message, rule: "unsupported-expression", suggestion, source }],
  });
};
