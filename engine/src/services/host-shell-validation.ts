import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { ToolingCompileError } from "@lando/sdk/errors";
import type { ToolingHostStep } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import {
  type BunShellDialectIssue,
  bunShellDialectIssues,
  bunShellScriptIssue,
  describeBunShellIssue,
} from "./bun-shell-dialect.ts";

const dialectFailure = Effect.fnUntraced(function* (
  tool: string,
  location: string,
  detail: string,
  issue: BunShellDialectIssue,
  redactionTokens: ReadonlyArray<string>,
) {
  const service = yield* Effect.serviceOption(RedactionService);
  const options = { sourceEnv: process.env, redactionTokens };
  const redactor = Option.isSome(service)
    ? yield* service.value.forProfile("secrets", options)
    : createStandaloneRedactor("secrets", options);
  return yield* Effect.fail(
    new ToolingCompileError({
      tool,
      message: redactor.redactString(`${location}: ${detail}`),
      remediation: redactor.redactString(issue.suggestion),
    }),
  );
});

/** Rejects every host shell step of a task before any of them runs. */
export const validateHostShellSteps = Effect.fnUntraced(function* (
  tool: string,
  steps: ReadonlyArray<ToolingHostStep>,
  redactionTokens: ReadonlyArray<string> = [],
) {
  for (const step of steps) {
    if (step.kind !== "shell") continue;
    const issue = bunShellDialectIssues(step.source)[0];
    if (issue !== undefined)
      return yield* dialectFailure(
        tool,
        `Host command for ${tool}`,
        describeBunShellIssue(issue),
        issue,
        redactionTokens,
      );
  }
});

/** Rejects a `.bun.sh` script before it runs, reporting the line and column. */
export const validateHostShellScript = Effect.fnUntraced(function* (
  tool: string,
  path: string,
  redactionTokens: ReadonlyArray<string> = [],
) {
  const source = yield* Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) =>
      new ToolingCompileError({
        message: `Cannot read script ${path}.`,
        tool,
        remediation: "Check that the script exists and is readable, then rerun the command.",
        cause,
      }),
  });
  const issue = bunShellScriptIssue(source);
  if (issue === undefined) return;
  return yield* dialectFailure(
    tool,
    `${path}:${issue.line}:${issue.column}`,
    issue.message,
    issue,
    redactionTokens,
  );
});
