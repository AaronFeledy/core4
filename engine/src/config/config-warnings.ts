import {
  type CommandWarning,
  type ValidationIssue,
  formatValidationIssueLine,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";

export const recordConfigWarning = Effect.fnUntraced(function* (warning: CommandWarning) {
  yield* recordCommandWarning(warning);
  const machine = yield* commandWarningsUseMachineOutput;
  const renderer = yield* Effect.serviceOption(Renderer);
  if (!machine && Option.isSome(renderer))
    yield* renderer.value.message.warn(warning.message).pipe(Effect.ignore);
});

export const recordPreexistingConfigIssues = (file: string, issues: readonly ValidationIssue[]) =>
  recordConfigWarning({
    code: "LANDO_CONFIG_PREEXISTING_ISSUES",
    message: `Pre-existing issues remain in ${file}:\n${issues.map((issue) => formatValidationIssueLine({ ...issue, suggestion: issue.suggestion ?? `Fix or unset ${formatValidationIssuePath(issue.path)} in ${file}.` })).join("\n")}`,
    remediation: `Fix the remaining issues in ${file} with set/unset, or edit the file.`,
  });
