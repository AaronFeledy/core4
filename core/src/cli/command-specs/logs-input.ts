import type { LogsAppResult } from "@lando/engine/operations/logs";
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

export { extractSpecAbortSignal as logSignalFromInput } from "../spec/command-base";

export const logLinesToStreamFrames = (result: Pick<LogsAppResult, "lines">) =>
  result.lines.map((line) => ({
    _tag: line.stream,
    service: line.service,
    chunk: `${line.line}\n`,
    ...(line.source === undefined ? {} : { source: line.source }),
  }));
