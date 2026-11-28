import type { NormalizedBunShellScript } from "@lando/landofile/bun-sh-metadata";
import { evaluateInvocationSite, serviceUrlReads } from "@lando/landofile/compiled-sites";
import { ConfigExpressionError, ToolingCompileError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, type ValidationIssue } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { loadUserLandofileAt } from "../landofile/app-resolution.ts";
import { type ServiceUrlFailureReason, markInvocationRefusal } from "../tooling/event-errors.ts";
import { resolveInvocationServiceUrls, serviceUrlFailureText } from "./invocation-service-urls.ts";
import { resolveToolingPlan } from "./tooling-plan.ts";

const siteIssues = (
  task: Pick<NormalizedBunShellScript, "env">,
  reason: ServiceUrlFailureReason,
): ValidationIssue[] =>
  task.env.flatMap((entry) => {
    const read = serviceUrlReads(entry.site.template).services.entries().next().value;
    if (read === undefined) return [];
    const [service, facts] = read;
    const text = serviceUrlFailureText(reason, { service, fact: facts.values().next().value ?? "url" });
    return [
      {
        rule: "landofile.tooling" as const,
        reason,
        path: entry.site.path,
        source: entry.site.source,
        message: text.message,
        suggestion: text.suggestion,
      },
    ];
  });

/**
 * An invocation without the app tier must report a route-fact refusal instead of a
 * missing-service defect.
 */
const planForScript = Effect.fnUntraced(function* (appRoot: string) {
  const planner = yield* Effect.serviceOption(AppPlanner);
  const landofiles = yield* Effect.serviceOption(LandofileService);
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(planner) || Option.isNone(landofiles) || Option.isNone(registry)) return undefined;
  const landofile = yield* loadUserLandofileAt(landofiles.value, AbsolutePath.make(appRoot));
  return yield* resolveToolingPlan({ landofile, appRoot }).pipe(
    Effect.provideService(AppPlanner, planner.value),
    Effect.provideService(RuntimeProviderRegistry, registry.value),
  );
});

const describeValue = (value: unknown): string =>
  Array.isArray(value)
    ? "a list"
    : value === null
      ? "null"
      : typeof value === "object"
        ? "a record"
        : `a ${typeof value}`;

const nonTextValue = (tool: string, entry: NormalizedBunShellScript["env"][number], value: unknown) => {
  const { source } = entry.site;
  const file = "file" in source ? source.file : JSON.stringify(source.path);
  const detail = `env.${entry.name} in ${file} produced ${describeValue(value)}; a script env value must be text.`;
  const remediation = "Return text, or keep the value as literal text in the front matter.";
  return new ToolingCompileError({
    tool,
    message: detail,
    remediation,
    issues: [
      {
        rule: "landofile.tooling",
        reason: "non-text-value",
        path: entry.site.path,
        source,
        message: detail,
        suggestion: remediation,
      },
    ],
  });
};

const invalidEnvValue = (tool: string, entry: NormalizedBunShellScript["env"][number], cause: unknown) => {
  const { source } = entry.site;
  const file = "file" in source ? source.file : JSON.stringify(source.path);
  const detail =
    cause instanceof ConfigExpressionError
      ? {
          message: cause.message,
          ...(cause.remediation === undefined ? {} : { suggestion: cause.remediation }),
        }
      : { message: "Lando could not evaluate the expression." };
  return new ToolingCompileError({
    tool,
    message: `env.${entry.name} in ${file} is invalid: ${detail.message}`,
    remediation: detail.suggestion ?? "Use literal text or a public service route fact.",
    issues: [
      {
        rule: "landofile.tooling",
        reason: "invalid-env-value",
        path: entry.site.path,
        source: entry.site.source,
        message: detail.message,
        ...(detail.suggestion === undefined ? {} : { suggestion: detail.suggestion }),
      },
    ],
    ...(cause === undefined ? {} : { cause }),
  });
};

/**
 * Resolves a script's front-matter `env` values as literal text plus the public route facts it
 * reads, through the same applied-state and router resolution tooling uses. A script that reads no
 * route fact resolves nothing and needs no plan.
 */
export const resolveBunShellScriptEnv = Effect.fnUntraced(function* (input: {
  readonly task: Pick<NormalizedBunShellScript, "name" | "env" | "readsRouteFacts">;
  readonly appRoot: string;
  readonly plan?: AppPlan | undefined;
}) {
  if (input.task.env.length === 0) return {};
  const plan =
    input.task.readsRouteFacts && input.plan === undefined ? yield* planForScript(input.appRoot) : input.plan;
  if (input.task.readsRouteFacts && plan === undefined) {
    const issues = siteIssues(input.task, "runtime-unavailable");
    const [first] = issues;
    return yield* Effect.fail(
      markInvocationRefusal(
        new ToolingCompileError({
          tool: input.task.name,
          message: first?.message ?? `A public route fact is unavailable for ${input.task.name}.`,
          remediation: first?.suggestion ?? "Run the command with the app bootstrap layer.",
          issues,
        }),
      ),
    );
  }
  const facts =
    plan === undefined
      ? undefined
      : yield* resolveInvocationServiceUrls({
          plan,
          tool: input.task.name,
          sites: input.task.env.map((entry) => entry.site),
          effectivePath: (site) => site.path,
        });
  const env: Record<string, string> = {};
  for (const entry of input.task.env) {
    const value = yield* Effect.try({
      try: () => evaluateInvocationSite(entry.site, facts === undefined ? {} : { services: facts }),
      catch: (cause) => markInvocationRefusal(invalidEnvValue(input.task.name, entry, cause)),
    });
    if (typeof value !== "string")
      return yield* Effect.fail(markInvocationRefusal(nonTextValue(input.task.name, entry, value)));
    env[entry.name] = value;
  }
  return env;
});
