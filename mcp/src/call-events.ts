import { type LandoEvent, PostMcpCallEvent, PreMcpCallEvent } from "@lando/sdk/events";
import { REDACTED } from "@lando/sdk/secrets";
import type { Redactor } from "@lando/sdk/secrets";
import { DateTime } from "effect";
import type { McpDispatchDeps } from "./dispatch";

export const boundedEventString = (redactor: Redactor, value: string): string =>
  redactor.redactStringBounded?.(value, 64 * 1024) ?? REDACTED;

interface CallEventInput {
  readonly toolId: string;
  readonly commandId: string;
  readonly appRef: string | undefined;
}
interface PostEventInput extends CallEventInput {
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly failureDetail: string | undefined;
}

export const preEvent = (deps: McpDispatchDeps, input: CallEventInput, now: number): LandoEvent =>
  PreMcpCallEvent.make({
    eventName: "pre-mcp-call",
    toolId: boundedEventString(deps.redactor, input.toolId),
    commandId: boundedEventString(deps.redactor, input.commandId),
    ...(input.appRef === undefined ? {} : { appRef: input.appRef }),
    timestamp: DateTime.makeUnsafe(now),
  });

export const postEvent = (deps: McpDispatchDeps, input: PostEventInput, now: number): LandoEvent =>
  PostMcpCallEvent.make({
    eventName: "post-mcp-call",
    toolId: boundedEventString(deps.redactor, input.toolId),
    commandId: boundedEventString(deps.redactor, input.commandId),
    ...(input.appRef === undefined ? {} : { appRef: input.appRef }),
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.failureDetail === undefined
      ? {}
      : { failureDetail: boundedEventString(deps.redactor, input.failureDetail) }),
    timestamp: DateTime.makeUnsafe(now),
  });
