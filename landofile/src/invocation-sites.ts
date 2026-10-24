import { ConfigExpressionError } from "@lando/sdk/errors";
import {
  type ExpressionContext,
  ExpressionTemplate,
  evaluateTemplateEither,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { isPlainRecord } from "@lando/sdk/landofile";
import { LandofileSourceValue, ParsedPendingSite } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { templateSource } from "./expression-source.ts";
import { captureTemplate } from "./invocation-captures.ts";

export const INVOCATION_SCOPES = ["event", "vars", "item", "key"] as const;

/** Only executable declaration positions can retain invocation-time expressions. */
export const executableExpressionPath = (path: readonly (string | number)[]): boolean => {
  const [root, name, field] = path;
  if (root === "events") return typeof name === "string" && typeof field === "number";
  if (root === "toolingIncludes" || root === "includes") return field === "vars";
  if (root !== "tooling" && root !== "toolingDefaults") return false;
  const key = root === "tooling" ? field : name;
  return (
    key === undefined || ["cmd", "cmds", "service", "dir", "user", "env", "vars", "if"].includes(String(key))
  );
};

export const InvocationSite = Schema.Struct({
  ...ParsedPendingSite.fields,
  template: ExpressionTemplate,
  expression: Schema.String,
  captures: Schema.Record(Schema.String, LandofileSourceValue),
});
export type InvocationSite = typeof InvocationSite.Type;
export const InvocationProgram = Schema.Array(InvocationSite);
export type InvocationProgram = typeof InvocationProgram.Type;

export const siteExpression = (site: ParsedPendingSite, document?: unknown, prefixLength = 0): string => {
  if ("expression" in site && typeof site.expression === "string") return site.expression;
  let value = document;
  for (const key of site.path.slice(prefixLength))
    value =
      Array.isArray(value) && typeof key === "number"
        ? value[key]
        : isPlainRecord(value)
          ? value[String(key)]
          : undefined;
  return typeof value === "string" ? value : templateSource(site.template);
};

export const compileInvocationSites = (
  sites: readonly ParsedPendingSite[],
  context: ExpressionContext,
  document?: unknown,
): Effect.Effect<InvocationProgram, ConfigExpressionError> =>
  Effect.forEach(sites, (site) =>
    Effect.try({
      try: () =>
        InvocationSite.make({
          ...site,
          ...captureTemplate(site, context),
          expression: siteExpression(site, document),
        }),
      catch: (cause) =>
        cause instanceof ConfigExpressionError
          ? cause
          : new ConfigExpressionError({
              message: "Invalid static invocation capture.",
              path: site.path.join("."),
              expression: siteExpression(site, document),
              filePath: "file" in site.source ? site.source.file : "<invocation>",
              remediation: "Use a valid bounded static value or binding reference.",
            }),
    }),
  );

/** Explicit authored boundary for standalone/host programs, never for compiled values. */
export const authoredInvocationSites = (value: unknown, file: string): InvocationProgram => {
  const sites: ParsedPendingSite[] = [];
  const visit = (entry: unknown, path: readonly (string | number)[]): void => {
    if (typeof entry === "string") {
      const template = parseExpressionEither(entry, { filePath: file, bareShellParameters: "preserve" });
      if (Result.isFailure(template)) throw template.failure;
      {
        const source = { file, layer: "base" as const, path };
        sites.push({ id: JSON.stringify(source), path, source, template: template.success });
      }
    } else if (Array.isArray(entry)) entry.forEach((child, index) => visit(child, [...path, index]));
    else if (isPlainRecord(entry))
      for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
  };
  visit(value, []);
  return sites.map((site) =>
    InvocationSite.make({ ...site, expression: siteExpression(site, value), captures: {} }),
  );
};

export const evaluateInvocationSite = (site: InvocationSite, context: ExpressionContext) => {
  const result = evaluateTemplateEither(
    site.template,
    {
      ...context,
      services: { ...context.services, __invocationCaptures: site.captures },
    },
    {
      path: site.source.path.join("."),
      filePath: "file" in site.source ? site.source.file : "<invocation>",
      expression: site.expression,
      budget: { maxSteps: 1024, maxDepth: 32, maxOutputBytes: 65536, maxCollectionSize: 256 },
    },
  );
  if (Result.isFailure(result))
    throw new ConfigExpressionError({
      message: result.failure.message,
      path: site.source.path.join("."),
      expression: site.expression,
      filePath: "file" in site.source ? site.source.file : "<invocation>",
      remediation: result.failure.remediation,
    });
  return result.success;
};
