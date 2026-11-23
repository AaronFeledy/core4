import { LandofileValidationError } from "@lando/sdk/errors";
import { type ExpressionTemplate, expressionScopeMembers } from "@lando/sdk/expressions";

import { isServiceEnvironmentValuePath } from "@lando/sdk/landofile/execution-sites";
import {
  type ServiceUrlReadRefusal,
  isServiceUrlInvocationPath,
  serviceUrlReads,
} from "./service-url-reads.ts";

export { isServiceEnvironmentValuePath };

export const ROUTE_URL_SITE_REMEDIATION =
  "Read a public URL with {{ services.<name>.url }} in a tooling command, cmds step, env value, or var, or in an event step's cmd, defer, env, or if, where Lando resolves it when the step runs. A service's map-form environment also accepts {{ service.url }}. Placement fields (service, user, dir), Lando command inputs, and include conditions cannot read it.";

const SELF_URL_REMEDIATION =
  "{{ service.url }} is only available in a service's map-form environment. Name the service instead: {{ services.<name>.url }}.";

const refusalText: Record<ServiceUrlReadRefusal, { readonly message: string; readonly remediation: string }> =
  {
    "computed-service": {
      message: "A services read with a computed service name",
      remediation: "Name the service literally, for example {{ services.web.url }}.",
    },
    "computed-member": {
      message: "A services read with a computed member",
      remediation: "Name the member literally, for example {{ services.web.url }}.",
    },
    "whole-service": {
      message: "A read of a whole services entry",
      remediation:
        "Read one published fact, such as {{ services.web.url }}, {{ services.web.port }}, or {{ services.web.creds.user }}.",
    },
  };

type FileSource = Extract<
  NonNullable<NonNullable<LandofileValidationError["issues"]>[number]["source"]>,
  { readonly file: string }
>;

const siteError = (source: FileSource, message: string, suggestion: string) =>
  new LandofileValidationError({
    file: source.file,
    message,
    remediation: suggestion,
    issues: [{ path: source.path, message, rule: "unsupported-expression", suggestion, source }],
  });

/** Load admission for public service URL reads at one authored value site. */
export const routeUrlSiteError = (
  template: ExpressionTemplate,
  source: NonNullable<LandofileValidationError["issues"]>[number]["source"],
): LandofileValidationError | undefined => {
  if (source === undefined || !("file" in source)) return undefined;
  const { path } = source;
  if (isServiceEnvironmentValuePath(path)) return undefined;
  const where = path.join(".");
  if (expressionScopeMembers(template, "service").members.has("url"))
    return siteError(source, `service.url is not supported at ${where}.`, SELF_URL_REMEDIATION);
  const reads = serviceUrlReads(template);
  if (isServiceUrlInvocationPath(path)) {
    if (reads.refusal === undefined) return undefined;
    const text = refusalText[reads.refusal];
    return siteError(source, `${text.message} is not supported at ${where}.`, text.remediation);
  }
  const named = [...reads.services][0];
  if (named !== undefined)
    return siteError(
      source,
      `services.${named}.url is not supported at ${where}.`,
      ROUTE_URL_SITE_REMEDIATION,
    );
  return reads.refusal === "computed-service"
    ? siteError(
        source,
        `A services URL read with a computed service name is not supported at ${where}.`,
        ROUTE_URL_SITE_REMEDIATION,
      )
    : undefined;
};
