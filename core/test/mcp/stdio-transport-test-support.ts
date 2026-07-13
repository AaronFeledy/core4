import { expect } from "bun:test";
import { Cause, Exit, Option } from "effect";

import { McpTransportError } from "@lando/sdk/errors";

export const expectMcpTransportFailure = (exit: Exit.Exit<unknown, unknown>): void => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isSuccess(exit)) return;
  const failure = Cause.failureOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) expect(failure.value).toBeInstanceOf(McpTransportError);
};

export const expectPolledMcpTransportFailure = (
  completion: Option.Option<Exit.Exit<unknown, unknown>>,
): void => {
  expect(Option.isSome(completion)).toBe(true);
  if (Option.isSome(completion)) expectMcpTransportFailure(completion.value);
};
