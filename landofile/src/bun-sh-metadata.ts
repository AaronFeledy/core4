import { BunShellScriptFrontMatterError, LandofileParseError } from "@lando/sdk/errors";
import { type ToolingInputDeclaration, validationIssue } from "@lando/sdk/schema";
import { Result } from "effect";
import type { BunShellScriptDiscoveryError, DiscoveredBunShellScript } from "./bun-sh-discovery.ts";
import { normalizeToolingInput } from "./tooling-input-normalize.ts";

export interface NormalizedBunShellScript {
  readonly name: string;
  readonly summary: string;
  readonly disabled: boolean;
  readonly source: { readonly path: string; readonly task: string };
  readonly input: ToolingInputDeclaration;
  /** Literal script target, never a tooling service-flag reference. */
  readonly rawService: string;
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
  const fail = (message: string) =>
    Result.fail(
      new BunShellScriptFrontMatterError({
        message: `.bun.sh front-matter at ${script.path} is invalid: ${message}`,
        path: script.path,
        issues: [validationIssue([], message)],
        remediation: "Correct the script's input declarations and ensure input environment names are unique.",
      }),
    );
  const normalized = normalizeToolingInput(script.name, script.frontMatter, { path: script.path });
  if (Result.isFailure(normalized)) return fail(normalized.failure.message);
  const inputEnvSuffixes = { flags: {}, args: {} };
  for (const group of ["flags", "args"] as const) {
    const suffixes = new Map<string, string>();
    for (const input of normalized.success[group]) {
      const suffix = input.name.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase();
      const previous = suffixes.get(suffix);
      if (previous !== undefined)
        return fail(`${group} ${previous} and ${input.name} collide on environment suffix ${suffix}.`);
      suffixes.set(suffix, input.name);
    }
    inputEnvSuffixes[group] = Object.fromEntries([...suffixes].map(([suffix, name]) => [name, suffix]));
  }
  return Result.succeed({
    name: script.name,
    summary: script.summary,
    disabled: script.frontMatter.disabled ?? false,
    source: { path: script.path, task: script.name },
    input: normalized.success,
    rawService: script.service,
    inputEnvSuffixes,
  });
};
