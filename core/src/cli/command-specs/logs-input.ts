import type { LogsAppResult } from "@lando/engine/operations/logs";
import { CommandInputValidationError } from "@lando/sdk/errors";
import { booleanFlag, specFlagsOf, stringFlag } from "../spec/input-coercion";

export const logOptionsFromInput = (input: unknown) => {
  const flags = specFlagsOf(input);
  const service = stringFlag(flags, "service");
  const since = stringFlag(flags, "since");
  return {
    ...(service === undefined ? {} : { service }),
    ...(typeof flags.tail === "number" ? { tail: flags.tail } : {}),
    ...(since === undefined ? {} : { since }),
  };
};

export const logFollowFromInput = (input: unknown): boolean => booleanFlag(specFlagsOf(input), "follow");

export const logBuildFromInput = (input: unknown): boolean => booleanFlag(specFlagsOf(input), "build");

/** `--build` prints recorded build output, so live/stream-selecting flags cannot apply. */
export const logBuildConflictFromInput = (input: unknown): CommandInputValidationError | undefined => {
  if (!logBuildFromInput(input)) return undefined;
  const flags = specFlagsOf(input);
  const conflicts = [
    ...(flags.follow === true ? ["follow"] : []),
    // Presence, not a non-empty value: `--since=` and `--source=` are supplied flags too.
    ...(flags.since !== undefined ? ["since"] : []),
    ...(flags.source !== undefined ? ["source"] : []),
  ];
  const flag = conflicts[0];
  if (flag === undefined) return undefined;
  return new CommandInputValidationError({
    message: `logs: --build cannot be combined with --${flag}.`,
    target: "app:logs",
    field: flag,
    kind: "flag",
    reason: "conflict",
    remediation: `Remove --${flag} when using --build.`,
  });
};

export { extractSpecAbortSignal as logSignalFromInput } from "../spec/command-base";

export const logLinesToStreamFrames = (result: Pick<LogsAppResult, "lines">) =>
  (result.lines ?? []).map((line) => ({
    _tag: line.stream,
    service: line.service,
    chunk: `${line.line}\n`,
    ...(line.source === undefined ? {} : { source: line.source }),
  }));
