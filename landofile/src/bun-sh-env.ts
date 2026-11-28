import {
  expressionInterpolationsTouchOnlyScopes,
  expressionScopeMemberPaths,
  expressionScopeRoots,
  parseExpressionEither,
} from "@lando/sdk/expressions";
import { PUBLIC_ROUTE_FACTS, type ValidationIssue } from "@lando/sdk/schema";
import { Result } from "effect";
import { type InvocationSite, InvocationSite as InvocationSiteSchema } from "./invocation-sites.ts";
import { isPublicRouteFact, serviceUrlReads } from "./service-url-reads.ts";

/**
 * One authored `.bun.sh` front-matter `env` value, parsed once at discovery into the expression
 * site the invocation resolves. Discovery never evaluates it, and the site never captures a
 * service route fact, so the app command index stays expression-free.
 */
export interface BunShellScriptEnvEntry {
  readonly name: string;
  readonly site: InvocationSite;
}

const ROUTE_FACTS = PUBLIC_ROUTE_FACTS.join(", ");
const BUN_SCRIPT_ENV_REMEDIATION = `Use literal text or a public route fact: {{ services.<name>.<fact> }} (${ROUTE_FACTS}).`;

/**
 * Whether a `.bun.sh` env value is text plus literal `services.<name>.<fact>` reads and nothing
 * else. Anything the invocation would silently read from another scope is refused here, while the
 * file is read, so lint and the command index report the same static findings.
 */
const inspectValue = (
  name: string,
  value: string,
  scriptPath: string,
): Result.Result<BunShellScriptEnvEntry, ValidationIssue> => {
  const path = ["env", name];
  const source = { file: scriptPath, layer: "script" as const, path };
  const fail = (reason: string, message: string, suggestion: string) =>
    Result.fail({
      path,
      reason,
      message,
      suggestion,
      source,
    });
  const folded = name.toUpperCase();
  if (folded === "LANDO" || folded.startsWith("LANDO_"))
    return fail(
      "reserved-env",
      `env.${name} uses a reserved environment name.`,
      "Rename the key; Lando owns the LANDO and LANDO_* environment names regardless of case.",
    );
  const parsed = parseExpressionEither(value, { filePath: scriptPath, bareShellParameters: "preserve" });
  if (Result.isFailure(parsed))
    return fail(
      "invalid-expression",
      `env.${name} is not a valid expression: ${parsed.failure.message}`,
      "Correct the expression, or double the opening braces to `{{{{` to keep the text as written.",
    );
  const template = parsed.success;
  const shellText = template.segments.find(
    (segment) => segment.kind === "ShellParamSegment" || segment.kind === "SecretRefSegment",
  );
  if (shellText?.kind === "ShellParamSegment")
    return fail(
      "shell-parameter",
      `env.${name} contains \${${shellText.name}}, which a script env value does not expand.`,
      BUN_SCRIPT_ENV_REMEDIATION,
    );
  if (shellText?.kind === "SecretRefSegment")
    return fail(
      "secret-reference",
      `env.${name} contains a secret reference, which a script env value cannot read.`,
      BUN_SCRIPT_ENV_REMEDIATION,
    );
  const [selfFact] = [...expressionScopeMemberPaths(template, "service").paths].flatMap(([, member]) =>
    member !== undefined && isPublicRouteFact(member) ? [member] : [],
  );
  if (selfFact !== undefined)
    return fail(
      "self-route-shorthand",
      `{{ service.${selfFact} }} is only available in a service's map-form environment.`,
      `Name the service instead: {{ services.<name>.${selfFact} }}.`,
    );
  const read = serviceUrlReads(template).reads.find((entry) => entry.kind !== "route");
  if (read !== undefined)
    switch (read.kind) {
      case "named":
        return fail(
          "non-route-fact",
          `env.${name} reads services.${read.service}.${read.member}, which is not a public route fact.`,
          BUN_SCRIPT_ENV_REMEDIATION,
        );
      case "unanalyzable":
        switch (read.refusal) {
          case "computed-service":
            return fail(
              "computed-service",
              `env.${name} reads a services fact through a computed service name.`,
              `Name the service literally, for example {{ services.web.${read.fact ?? "url"} }}.`,
            );
          case "computed-member":
            return fail(
              "computed-member",
              `env.${name} reads a services fact through a computed member.`,
              "Name the fact literally, for example {{ services.web.url }}.",
            );
          case "whole-service":
            return fail(
              "whole-service",
              `env.${name} reads a whole services entry.`,
              `Read one fact: {{ services.web.<fact> }} (${ROUTE_FACTS}).`,
            );
          default:
            return read satisfies never;
        }
      default:
        return read satisfies never;
    }
  if (!expressionInterpolationsTouchOnlyScopes(template, ["services"])) {
    const scope = [...expressionScopeRoots(template)].find((root) => root !== "services");
    return fail(
      "other-scope",
      `env.${name} reads ${scope === undefined ? "an expression" : `{{ ${scope}.* }}`}, which a script env value cannot.`,
      BUN_SCRIPT_ENV_REMEDIATION,
    );
  }
  return Result.succeed({
    name,
    site: InvocationSiteSchema.make({
      id: JSON.stringify(source),
      path,
      source,
      template,
      expression: value,
      captures: {},
    }),
  });
};

export const inspectBunShellScriptEnv = (
  env: Readonly<Record<string, string>> | undefined,
  scriptPath: string,
): Result.Result<readonly BunShellScriptEnvEntry[], readonly ValidationIssue[]> => {
  const entries: BunShellScriptEnvEntry[] = [];
  const issues: ValidationIssue[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    const inspected = inspectValue(name, value, scriptPath);
    if (Result.isFailure(inspected)) issues.push(inspected.failure);
    else entries.push(inspected.success);
  }
  return issues.length === 0 ? Result.succeed(entries) : Result.fail(issues);
};
