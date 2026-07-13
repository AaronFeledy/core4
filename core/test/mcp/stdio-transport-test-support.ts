import { expect } from "bun:test";
import { Cause, Exit, Option } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

export const expectMcpTransportFailure = (
  exit: Exit.Exit<unknown, unknown>,
): McpTransportError | undefined => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isNone(failure)) return undefined;
  expect(failure.value).toBeInstanceOf(McpTransportError);
  return failure.value instanceof McpTransportError ? failure.value : undefined;
};

export const expectPolledMcpTransportFailure = (
  completion: Option.Option<Exit.Exit<unknown, unknown>>,
): McpTransportError | undefined => {
  expect(Option.isSome(completion)).toBe(true);
  return Option.isSome(completion) ? expectMcpTransportFailure(completion.value) : undefined;
};
