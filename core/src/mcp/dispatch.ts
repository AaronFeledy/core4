/**
 * MCP tool dispatch engine.
 *
 * A projection, not a parallel surface: a tool call resolves to a canonical
 * `LandoCommandSpec`, its input is decoded from the derived schema, the command
 * runs through the retained-runtime `execute` seam (non-interactive), and the
 * result is the command's `CommandResultEnvelope` encoded through the single
 * `encodeCommandResult` seam — redaction included. `pre-mcp-call` /
 * `post-mcp-call` events publish for every dispatch, including rejected ones.
 *
 * A dispatched command's own tagged failure surfaces as an `ok: false` envelope
 * (a normal result), not an MCP-level error. MCP-level errors are limited to
 * allowlist rejection and input-schema rejection.
 */
import { Cause, DateTime, Effect, Option } from "effect";

import { McpToolInputError, McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import { type LandoEvent, PostMcpCallEvent, PreMcpCallEvent } from "@lando/sdk/events";
import type { Redactor } from "@lando/sdk/secrets";

import type { CommandResultOutcome } from "../cli/result-encode.ts";
import {
  encodeCommandResult,
  encodeStreamStderrFrame,
  encodeStreamStdoutFrame,
} from "../cli/result-encode.ts";
import { type McpCommandEntry, type McpToolInput, validateToolInput } from "./registry.ts";

export type McpDispatchError = McpToolNotAllowedError | McpToolInputError | McpTransportError;

export interface McpToolCallRequest {
  readonly toolId: string;
  readonly input?: McpToolInput;
}

export interface McpDispatchResult {
  /** The redacted `CommandResultEnvelope` object returned to the MCP client. */
  readonly envelope: unknown;
  /** `true` when the dispatched command succeeded (`envelope.ok === true`). */
  readonly ok: boolean;
}

export interface McpProgressFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
}

export type McpNotify = (frame: unknown) => Effect.Effect<void>;

/**
 * Runs a resolved command against the retained runtime and returns a
 * success/failure outcome. Interrupts propagate (cancellation), so this seam
 * must not swallow them.
 */
export type McpExecute = (
  entry: McpCommandEntry,
  runInput: McpRunInput,
) => Effect.Effect<CommandResultOutcome, never>;

export interface McpRunInput {
  readonly argv: ReadonlyArray<string>;
  readonly flags: Record<string, unknown>;
  readonly args: Record<string, unknown>;
  readonly interaction: "non-interactive";
  readonly appPath?: string;
}

export interface McpDispatchDeps {
  readonly registry: ReadonlyMap<string, McpCommandEntry>;
  readonly effective: ReadonlySet<string>;
  readonly allowlistSource: string;
  readonly redactor: Redactor;
  readonly execute: McpExecute;
  readonly notify?: McpNotify;
  readonly publish?: (event: LandoEvent) => Effect.Effect<void, unknown>;
  readonly now?: () => number;
}

const nowMs = (deps: McpDispatchDeps): number => (deps.now ?? Date.now)();

const appRefSummary = (deps: McpDispatchDeps, input: McpToolInput | undefined): string | undefined =>
  input?.appPath === undefined ? undefined : deps.redactor.redactString(input.appPath);

const emit = (deps: McpDispatchDeps, event: LandoEvent): Effect.Effect<void> =>
  deps.publish === undefined ? Effect.void : deps.publish(event).pipe(Effect.catchAll(() => Effect.void));

const preEvent = (deps: McpDispatchDeps, request: McpToolCallRequest, commandId: string): LandoEvent => {
  const appRef = appRefSummary(deps, request.input);
  return PreMcpCallEvent.make({
    eventName: "pre-mcp-call",
    toolId: request.toolId,
    commandId,
    ...(appRef === undefined ? {} : { appRef }),
    timestamp: DateTime.unsafeMake(nowMs(deps)),
  });
};

interface PostEventInput {
  readonly toolId: string;
  readonly commandId: string;
  readonly appRef: string | undefined;
  readonly outcome: "success" | "failure";
  readonly durationMs: number;
  readonly failureDetail: string | undefined;
}

const postEvent = (deps: McpDispatchDeps, input: PostEventInput): LandoEvent =>
  PostMcpCallEvent.make({
    eventName: "post-mcp-call",
    toolId: input.toolId,
    commandId: input.commandId,
    ...(input.appRef === undefined ? {} : { appRef: input.appRef }),
    outcome: input.outcome,
    durationMs: input.durationMs,
    ...(input.failureDetail === undefined
      ? {}
      : { failureDetail: deps.redactor.redactString(input.failureDetail) }),
    timestamp: DateTime.unsafeMake(nowMs(deps)),
  });

const envelopeTag = (envelope: unknown): string | undefined => {
  if (envelope === null || typeof envelope !== "object") return undefined;
  const error = (envelope as { readonly error?: unknown }).error;
  if (error === null || typeof error !== "object") return undefined;
  const tag = (error as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : undefined;
};

const encodeProgressFrame = (frame: McpProgressFrame, deps: McpDispatchDeps): Effect.Effect<string> =>
  frame._tag === "stdout"
    ? encodeStreamStdoutFrame({
        chunk: frame.chunk,
        ...(frame.service === undefined ? {} : { service: frame.service }),
        redactor: deps.redactor,
      })
    : encodeStreamStderrFrame({
        chunk: frame.chunk,
        ...(frame.service === undefined ? {} : { service: frame.service }),
        redactor: deps.redactor,
      });

const emitProgressFrame = (deps: McpDispatchDeps, frame: McpProgressFrame): Effect.Effect<void> =>
  deps.notify === undefined
    ? Effect.void
    : encodeProgressFrame(frame, deps).pipe(
        Effect.flatMap((line) => deps.notify?.(JSON.parse(line)) ?? Effect.void),
      );

/**
 * Dispatch a single MCP tool call. Resolves to the redacted command envelope, or
 * fails with an MCP-level error (`McpToolNotAllowedError` / `McpToolInputError`)
 * for calls that never reach the command. Publishes `pre-mcp-call` before the
 * decision and `post-mcp-call` after — for every call, including rejected ones.
 */
export const dispatchTool = (
  request: McpToolCallRequest,
  deps: McpDispatchDeps,
): Effect.Effect<McpDispatchResult, McpDispatchError> =>
  Effect.gen(function* () {
    const startedAt = nowMs(deps);
    const appRef = appRefSummary(deps, request.input);
    const entry = deps.registry.get(request.toolId);
    const commandId = entry?.spec.id ?? request.toolId;

    yield* emit(deps, preEvent(deps, request, commandId));

    const emitPost = (
      outcome: "success" | "failure",
      failureDetail: string | undefined,
    ): Effect.Effect<void> =>
      emit(
        deps,
        postEvent(deps, {
          toolId: request.toolId,
          commandId,
          appRef,
          outcome,
          durationMs: nowMs(deps) - startedAt,
          failureDetail,
        }),
      );

    const interruptedError = (): McpTransportError =>
      new McpTransportError({
        message: `MCP tool call ${request.toolId} was interrupted before completion.`,
        remediation: "Retry the MCP tool call if the cancellation was unintended.",
      });

    const run: Effect.Effect<McpDispatchResult, McpToolNotAllowedError | McpToolInputError> = Effect.gen(
      function* () {
        const rejectNotAllowed = (): McpToolNotAllowedError =>
          new McpToolNotAllowedError({
            message: `Tool ${request.toolId} is not in the effective MCP allowlist.`,
            toolId: request.toolId,
            effectiveAllowlist: [...deps.effective].sort((a, b) => a.localeCompare(b)),
            source: deps.allowlistSource,
            remediation: `Add ${request.toolId} to \`mcp.allow\` (or --allow) to expose it as an MCP tool.`,
          });

        if (entry === undefined || !deps.effective.has(request.toolId)) {
          const error = rejectNotAllowed();
          yield* emitPost("failure", error._tag);
          return yield* Effect.fail(error);
        }

        const validated = yield* Effect.try({
          try: () => validateToolInput(entry.spec, request.input),
          catch: (error) =>
            error instanceof McpToolInputError
              ? error
              : new McpToolInputError({
                  message: `Invalid input for tool ${request.toolId}.`,
                  toolId: request.toolId,
                  remediation: "Provide input matching the tool's derived schema.",
                }),
        }).pipe(Effect.tapError((error) => emitPost("failure", error._tag)));

        const runInput: McpRunInput = {
          argv: [],
          flags: validated.flags,
          args: validated.args,
          interaction: "non-interactive",
          ...(request.input?.appPath === undefined ? {} : { appPath: request.input.appPath }),
        };

        const outcome = yield* deps.execute(entry, runInput);
        if (outcome._tag === "success") {
          for (const frame of entry.spec.streamFrames?.(outcome.value) ?? []) {
            yield* emitProgressFrame(deps, frame);
          }
        }
        const line = yield* encodeCommandResult({
          command: entry.spec.id,
          resultSchema: entry.spec.resultSchema,
          outcome,
          redactor: deps.redactor,
        });
        const envelope: unknown = JSON.parse(line);
        const ok = (envelope as { readonly ok?: unknown }).ok === true;

        yield* emitPost(ok ? "success" : "failure", ok ? undefined : envelopeTag(envelope));

        return { envelope, ok };
      },
    );

    const exit = yield* Effect.exit(run);
    if (exit._tag === "Success") return exit.value;
    if (Cause.isInterruptedOnly(exit.cause)) {
      yield* emitPost("failure", "Interrupted");
      return yield* Effect.fail(interruptedError());
    }
    const failure = Cause.failureOption(exit.cause);
    return yield* Option.isSome(failure) ? Effect.fail(failure.value) : Effect.die(Cause.squash(exit.cause));
  });
