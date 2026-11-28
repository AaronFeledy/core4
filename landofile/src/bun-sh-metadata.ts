import { BunShellScriptFrontMatterError, LandofileParseError } from "@lando/sdk/errors";
import type { ToolingInputDeclaration, ValidationIssue } from "@lando/sdk/schema";
import { Result } from "effect";
import type { BunShellScriptDiscoveryError, DiscoveredBunShellScript } from "./bun-sh-discovery.ts";
import { type BunShellScriptEnvEntry, inspectBunShellScriptEnv } from "./bun-sh-env.ts";
import { readsServiceUrl } from "./service-url-reads.ts";
import { inspectToolingInput } from "./tooling-input-normalize.ts";

export interface NormalizedBunShellScript {
  readonly name: string;
  readonly summary: string;
  readonly disabled: boolean;
  readonly source: { readonly path: string; readonly task: string };
  readonly input: ToolingInputDeclaration;
  /** Literal script target, never a tooling service-flag reference. */
  readonly rawService: string;
  /** Authored `env` values as unevaluated invocation sites, in declaration order. */
  readonly env: readonly BunShellScriptEnvEntry[];
  /** Whether a declared env value reads a public route fact, so the script needs the app tier. */
  readonly readsRouteFacts: boolean;
  /** Declared name to portable suffix, without LANDO_FLAG_ / LANDO_ARG_ prefixes. */
  readonly inputEnvSuffixes: {
    readonly flags: Readonly<Record<string, string>>;
    readonly args: Readonly<Record<string, string>>;
  };
}

export const isBunShellScriptMetadataFailure = (error: BunShellScriptDiscoveryError): boolean => {
  switch (error._tag) {
    case "BunShellScriptEmptyError":
    case "NotImplementedError":
      return true;
    case "BunShellScriptFrontMatterError":
      return error.cause === undefined || error.cause instanceof LandofileParseError;
    default:
      return error satisfies never;
  }
};

/** Shared by discovery, execution and cache fingerprinting; never evaluates expressions. */
export const normalizeBunShellScript = (
  script: DiscoveredBunShellScript,
): Result.Result<NormalizedBunShellScript, BunShellScriptFrontMatterError> => {
  const normalized = inspectToolingInput(script.frontMatter);
  const env = inspectBunShellScriptEnv(script.frontMatter.env, script.path);
  const inputFailed = Result.isFailure(normalized);
  const envFailed = Result.isFailure(env);
  const located = (issue: ValidationIssue): ValidationIssue => ({
    ...issue,
    source: issue.source ?? { layer: "script", file: script.path, path: issue.path },
  });
  const issues: ValidationIssue[] = [];
  if (inputFailed) issues.push(...normalized.failure.map(located));
  if (envFailed) issues.push(...env.failure);
  const inputEnvSuffixes = { flags: {}, args: {} };
  if (!inputFailed)
    for (const group of ["flags", "args"] as const) {
      const suffixes = new Map<string, string>();
      for (const input of normalized.success[group]) {
        const suffix = input.name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
        const previous = suffixes.get(suffix);
        if (previous !== undefined)
          issues.push(
            located({
              path: [group, input.name],
              reason: "input-env-suffix",
              message: `${group} ${previous} and ${input.name} collide on environment suffix ${suffix}.`,
              suggestion: "Rename one of them so each environment suffix is unique.",
            }),
          );
        suffixes.set(suffix, input.name);
      }
      inputEnvSuffixes[group] = Object.fromEntries([...suffixes].map(([suffix, name]) => [name, suffix]));
    }
  if (issues.length === 0 && !inputFailed && !envFailed)
    return Result.succeed({
      name: script.name,
      summary: script.summary,
      disabled: script.frontMatter.disabled ?? false,
      source: { path: script.path, task: script.name },
      input: normalized.success,
      rawService: script.service,
      env: env.success,
      readsRouteFacts: env.success.some((entry) => readsServiceUrl(entry.site.template)),
      inputEnvSuffixes,
    });
  const declarations =
    inputFailed && envFailed
      ? "input and env declarations"
      : envFailed
        ? "env declarations"
        : "input declarations";
  return Result.fail(
    new BunShellScriptFrontMatterError({
      path: script.path,
      message: `.bun.sh front-matter at ${script.path} has invalid ${declarations}.`,
      issues,
      remediation: `Correct the script's ${declarations}.`,
    }),
  );
};
