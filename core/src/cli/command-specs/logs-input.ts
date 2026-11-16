import type { LogsAppResult } from "@lando/engine/operations/logs";
import { redactLineSequence } from "@lando/redaction/line-stream";
import { RedactionService } from "@lando/redaction/service";
import { CommandInputValidationError } from "@lando/sdk/errors";
import { Effect, Option } from "effect";
import { CliInvocation } from "../../runtime/invocation-context";
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

/**
 * Collected log lines hold one string per line, so every per-string redaction downstream would
 * leak a secret that spans lines one line at a time. Redact each output stream (service, stream,
 * and source) as one line sequence first, so text, TTY, JSON, YAML, and MCP results all carry
 * the same safe lines. A line merged into the one before it is dropped.
 */
export const redactLogLineStreams = Effect.fnUntraced(function* (result: LogsAppResult) {
  const lines = result.lines;
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (lines === undefined || lines.length === 0 || Option.isNone(redaction)) return result;
  const scopeOptions = { sourceEnv: (yield* CliInvocation).env };
  const scope = {
    redactor: yield* redaction.value.forProfile("secrets", scopeOptions),
    payloadValues: yield* redaction.value.payloadValues(scopeOptions),
  };
  const streams = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const key = JSON.stringify([line.service, line.stream, line.source]);
    const positions = streams.get(key);
    if (positions === undefined) streams.set(key, [index]);
    else positions.push(index);
  });
  const safe: Array<string | undefined> = [];
  for (const positions of streams.values()) {
    const redacted = redactLineSequence(
      scope,
      positions.map((position) => lines[position]?.line ?? ""),
    );
    positions.forEach((position, index) => {
      safe[position] = redacted[index];
    });
  }
  return {
    ...result,
    lines: lines.flatMap((line, index) => {
      const text = safe[index];
      return text === undefined ? [] : [{ ...line, line: text }];
    }),
  };
});
