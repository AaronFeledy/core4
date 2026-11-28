import { ConfigExpressionError } from "@lando/sdk/errors";
import {
  type EvaluationBudget,
  type ExpressionContext,
  evaluateTemplateEither,
  expressionInterpolationsTouchOnlyScopes,
  expressionScopeMembers,
} from "@lando/sdk/expressions";
import { type ValueOrigins, isPlainRecord } from "@lando/sdk/landofile";
import {
  EnvironmentValue,
  PUBLIC_ROUTE_FACTS,
  type ParsedPendingSite,
  SecretRef,
  type ValidationIssuePath,
  type ValidationIssueSource,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { type InvocationProgram, evaluateInvocationSite, siteExpression } from "./invocation-sites.ts";
import type { AuthoredOrigin } from "./provenance.ts";
import { ROUTE_URL_SITE_REMEDIATION, isServiceEnvironmentValuePath } from "./route-url-expression.ts";
import { eligibleBindingPath } from "./secret-reference.ts";
import { readsServiceUrl } from "./service-url-reads.ts";

export * from "./invocation-sites.ts";
export { routeUrlSiteError } from "./route-url-expression.ts";
export { isPublicRouteFact, serviceUrlReads } from "./service-url-reads.ts";
export {
  dynamicToolingNames,
  dynamicToolingReferenceIssues,
  serviceUrlPlacementIssues,
} from "./tooling-dynamic-references.ts";
export { consumedToolingInputs, toolingInvocationIssues } from "./tooling-invocation-input.ts";
export { readsToolingData, toolingDataNames } from "./tooling-provenance.ts";
export { bindToolingShellSite } from "./tooling-shell-binding.ts";

export const authoredSiteId = (source: ValidationIssueSource): string => JSON.stringify(source);

export const compiledValueError = (
  cause: unknown,
  input: {
    readonly filePath: string;
    readonly pendingSites: readonly ParsedPendingSite[];
    readonly pathPrefix?: ValidationIssuePath;
  },
): ConfigExpressionError => {
  const issue = validationIssuesFromCause(cause, {
    fallback: "Expression result does not match its destination type.",
  })[0];
  const path = [...(input.pathPrefix ?? []), ...(issue?.path ?? [])];
  const site = input.pendingSites.find((candidate) =>
    candidate.path.every((part, index) => path[index] === part),
  );
  return new ConfigExpressionError({
    message: issue?.message ?? "Expression result does not match its destination type.",
    path,
    ...(site === undefined ? {} : { source: site.source }),
    expression: site === undefined ? "" : siteExpression(site),
    filePath: site !== undefined && "file" in site.source ? site.source.file : input.filePath,
    remediation: "Return a value accepted by the destination field.",
  });
};

/** Rebase by origin identity, including keyed-array merges and aliases, never scalar equality. */
export const survivingSites = (
  origins: ValueOrigins<AuthoredOrigin>,
  sites: readonly ParsedPendingSite[],
): readonly ParsedPendingSite[] => {
  if (sites.length === 0) return [];
  const byOrigin = new Map(sites.map((site) => [site.id, site]));
  const result: ParsedPendingSite[] = [];
  const visit = (node: ValueOrigins<AuthoredOrigin>, path: ValidationIssuePath): void => {
    if (node.deleted) return;
    const site = byOrigin.get(authoredSiteId(node.source));
    if (site !== undefined && node.children.size === 0) result.push({ ...site, path });
    for (const [key, child] of node.children) visit(child, [...path, key]);
  };
  visit(origins, []);
  return result;
};

export const replaceSiteValue = (
  value: unknown,
  path: ValidationIssuePath,
  replacement: unknown,
): unknown => {
  const [key, ...rest] = path;
  if (key === undefined) return replacement;
  if (Array.isArray(value) && typeof key === "number")
    return value.map((entry, index) => (index === key ? replaceSiteValue(entry, rest, replacement) : entry));
  if (isPlainRecord(value) && typeof key === "string" && Object.hasOwn(value, key))
    return { ...value, [key]: replaceSiteValue(value[key], rest, replacement) };
  return value;
};

export const instantiateInvocation = (input: {
  readonly value: unknown;
  readonly sites: InvocationProgram;
  readonly context: ExpressionContext;
}) =>
  Effect.try({
    try: () => {
      let value = input.value;
      for (const site of input.sites) {
        const result = evaluateInvocationSite(site, input.context);
        const environment =
          site.path[0] === "env" ||
          (site.path[0] === "cmds" && typeof site.path[1] === "number" && site.path[2] === "env");
        const normalized =
          environment && (typeof result === "number" || typeof result === "boolean")
            ? String(result)
            : result;
        value = replaceSiteValue(value, site.path, normalized);
      }
      return value;
    },
    catch: (cause) =>
      cause instanceof ConfigExpressionError
        ? cause
        : compiledValueError(cause, {
            filePath: "<invocation>",
            pendingSites: input.sites,
          }),
  });

const containsRouteText = (value: unknown): boolean =>
  Array.isArray(value)
    ? value.some(containsRouteText)
    : isPlainRecord(value) && (value._tag === "RouteText" || Object.values(value).some(containsRouteText));

export const consumeSites = (input: {
  readonly document: unknown;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: ExpressionContext;
  readonly scopes: readonly string[];
  readonly pathPrefix?: ValidationIssuePath;
  readonly budget?: EvaluationBudget;
  readonly renderText?: boolean;
}) => {
  let document = input.document;
  const pendingSites: ParsedPendingSite[] = [];
  for (const site of input.pendingSites) {
    const environmentSite = isServiceEnvironmentValuePath(site.path);
    // Load admits route-fact reads outside a service environment only at invocation sites, where
    // the applied route table supplies them when the command runs; keep the whole expression for then.
    if (!environmentSite && readsServiceUrl(site.template)) {
      pendingSites.push(site);
      continue;
    }
    const selfName = environmentSite ? site.path[1] : undefined;
    const self = typeof selfName === "string" ? input.context.services?.[selfName] : undefined;
    const selfRoute = isPlainRecord(self)
      ? Object.fromEntries(PUBLIC_ROUTE_FACTS.map((fact) => [fact, self[fact]] as const))
      : undefined;
    const plannerSelf = isPlainRecord(input.context.service) ? input.context.service : undefined;
    const serviceSelf =
      plannerSelf === undefined && selfRoute === undefined ? undefined : { ...plannerSelf, ...selfRoute };
    // Only the planner supplies `service.port`, so a self-port read waits for it.
    if (
      plannerSelf?.port === undefined &&
      expressionScopeMembers(site.template, "service", "direct-property").members.has("port")
    ) {
      pendingSites.push(site);
      continue;
    }
    // Lowered shell sites keep their authored text: only binding sites materialize
    // into deferred descriptors here, or an invocation would receive a SecretRef object.
    if (
      !eligibleBindingPath(site.path) &&
      site.template.segments.some((segment) => segment.kind === "SecretRefSegment")
    ) {
      pendingSites.push(site);
      continue;
    }
    const scopes = [...input.scopes, "secrets", ...(serviceSelf === undefined ? [] : ["service"])];
    if (!expressionInterpolationsTouchOnlyScopes(site.template, scopes)) {
      pendingSites.push(site);
      continue;
    }
    const names = [
      ...site.template.segments.flatMap((segment) =>
        segment.kind === "SecretRefSegment" ? [segment.name] : [],
      ),
      ...expressionScopeMembers(site.template, "secrets").members,
    ];
    const secrets: Record<string, SecretRef> = {};
    for (const name of names) {
      const reference = Schema.decodeUnknownResult(SecretRef)({ _tag: "SecretRef", reference: name });
      if (Result.isFailure(reference))
        return Result.fail(
          new ConfigExpressionError({
            message: "Invalid secret reference identifier.",
            path: site.path,
            source: site.source,
            expression: siteExpression(site, input.document, input.pathPrefix?.length),
            filePath: "file" in site.source ? site.source.file : "<landofile>",
            remediation: "Use a supported secret store URI or a valid bare identifier.",
          }),
        );
      secrets[name] = reference.success;
    }
    const evaluated = evaluateTemplateEither(
      site.template,
      { ...input.context, ...(serviceSelf === undefined ? {} : { service: serviceSelf }), secrets },
      {
        path: site.path,
        filePath: "file" in site.source ? site.source.file : undefined,
        expression: siteExpression(site, input.document, input.pathPrefix?.length),
        budget: input.budget ?? {
          maxSteps: 1024,
          maxDepth: 32,
          maxOutputBytes: 65536,
          maxCollectionSize: 256,
        },
      },
    );
    if (Result.isFailure(evaluated))
      return Result.fail(
        new ConfigExpressionError({
          message: evaluated.failure.message,
          path: site.path,
          source: site.source,
          expression: siteExpression(site, input.document, input.pathPrefix?.length),
          filePath: "file" in site.source ? site.source.file : "<landofile>",
          remediation: evaluated.failure.remediation,
        }),
      );
    const value = evaluated.success;
    const rendered =
      input.renderText && typeof value === "number" && Number.isFinite(value) ? String(value) : value;
    // Load refuses a literal URL reference outside a service environment; a computed member
    // access can still produce the descriptor, so the destination is checked on the value too.
    const misplacedRoute = containsRouteText(rendered) && !environmentSite;
    if (misplacedRoute || (input.renderText && !Schema.is(EnvironmentValue)(rendered)))
      return Result.fail(
        new ConfigExpressionError({
          message: misplacedRoute
            ? `A public service route fact is not supported at ${site.path.join(".")}.`
            : "This field takes text; the expression must return text or a finite number.",
          path: site.path,
          source: site.source,
          expression: siteExpression(site, input.document, input.pathPrefix?.length),
          filePath: "file" in site.source ? site.source.file : "<landofile>",
          remediation: misplacedRoute
            ? ROUTE_URL_SITE_REMEDIATION
            : "Return text or a finite number instead of a boolean, null, or collection.",
        }),
      );
    document = replaceSiteValue(document, site.path.slice(input.pathPrefix?.length ?? 0), rendered);
  }
  return Result.succeed({ document, pendingSites });
};
