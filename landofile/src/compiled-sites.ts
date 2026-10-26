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
  type ParsedPendingSite,
  SecretRef,
  type ValidationIssuePath,
  type ValidationIssueSource,
  validationIssuesFromCause,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { type InvocationProgram, evaluateInvocationSite, siteExpression } from "./invocation-sites.ts";
import type { AuthoredOrigin } from "./pipeline/prepare.ts";
export * from "./invocation-sites.ts";

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
    path: path.join("."),
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
  if (isPlainRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, entry]) => [
        name,
        name === key ? replaceSiteValue(entry, rest, replacement) : entry,
      ]),
    );
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

export const consumeSites = (input: {
  readonly document: unknown;
  readonly pendingSites: readonly ParsedPendingSite[];
  readonly context: ExpressionContext;
  readonly scopes: readonly string[];
  readonly pathPrefix?: ValidationIssuePath;
  readonly budget?: EvaluationBudget;
}) => {
  let document = input.document;
  const pendingSites: ParsedPendingSite[] = [];
  for (const site of input.pendingSites) {
    if (!expressionInterpolationsTouchOnlyScopes(site.template, [...input.scopes, "secrets"])) {
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
            path: site.path.join("."),
            expression: siteExpression(site, input.document, input.pathPrefix?.length),
            filePath: "file" in site.source ? site.source.file : "<landofile>",
            remediation: "Use a supported secret store URI or a valid bare identifier.",
          }),
        );
      secrets[name] = reference.success;
    }
    const evaluated = evaluateTemplateEither(
      site.template,
      { ...input.context, secrets },
      {
        path: site.path.join("."),
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
          path: site.path.join("."),
          expression: siteExpression(site, input.document, input.pathPrefix?.length),
          filePath: "file" in site.source ? site.source.file : "<landofile>",
          remediation: evaluated.failure.remediation,
        }),
      );
    document = replaceSiteValue(document, site.path.slice(input.pathPrefix?.length ?? 0), evaluated.success);
  }
  return Result.succeed({ document, pendingSites });
};
