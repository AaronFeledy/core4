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
import { Cause, Clock, Effect, Option, Predicate, Schema } from "effect";

import { McpToolInputError, McpToolNotAllowedError, McpTransportError } from "@lando/sdk/errors";
import type { LandoEvent } from "@lando/sdk/events";
import type { Redactor } from "@lando/sdk/secrets";

import {
  type CommandResultOutcome,
  buildCommandResultEnvelope,
  failureOutcomeFromCause,
  normalizeDefect,
} from "@lando/sdk/command-result";
import { Logger } from "@lando/sdk/services";
import { redactBoundedJsonValue, stringifyBoundedJson } from "./bounded-json";
import { boundedEventString, postEvent, preEvent } from "./call-events";
import { OutputCapture } from "./output-capture";
import { encodeProgressFrame } from "./progress";
import { type McpCommandEntry, type McpToolInput, validateToolInput } from "./registry";
import { inspectMcpCommandOutcome } from "./result-inspector";

export type McpDispatchError = McpToolNotAllowedError | McpToolInputError | McpTransportError;

export interface McpToolCallRequest {
  readonly toolId: string;
  readonly input?: McpToolInput;
}

export interface McpDispatchResult {
  /** The redacted `CommandResultEnvelope` object returned to the MCP client. */
  readonly envelope: import("effect").Schema.Json;
  /** `true` when the dispatched command succeeded (`envelope.ok === true`). */
  readonly ok: boolean;
}

export interface McpProgressFrame {
  readonly _tag: "stdout" | "stderr";
  readonly chunk: string;
  readonly service?: string;
  readonly source?: string;
}

export type McpNotify = (frame: unknown) => Effect.Effect<void, McpTransportError>;

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
  readonly resultRedactor: (tokens: ReadonlyArray<string>) => Effect.Effect<Redactor>;
  readonly execute: McpExecute;
  readonly notify?: McpNotify;
  readonly publish?: (event: LandoEvent) => Effect.Effect<void, unknown>;
  readonly now?: () => number;
  readonly rejection?: McpDispatchError;
  readonly capture?: OutputCapture;
}

const nowMs = (deps: McpDispatchDeps) =>
  deps.now === undefined ? Clock.currentTimeMillis : Effect.sync(deps.now);

const appRefSummary = (deps: McpDispatchDeps, input: McpToolInput | undefined): string | undefined =>
  input?.appPath === undefined ? undefined : boundedEventString(deps.redactor, input.appPath);

const emit = (deps: McpDispatchDeps, event: LandoEvent): Effect.Effect<void> =>
  deps.publish === undefined ? Effect.void : deps.publish(event).pipe(Effect.catch(() => Effect.void));

const envelopeTag = (envelope: unknown): string | undefined => {
  if (!Predicate.isObject(envelope)) return undefined;
  const error = envelope.error;
  if (!Predicate.isObject(error)) return undefined;
  const tag = error._tag;
  return typeof tag === "string" ? tag : undefined;
};

const emitProgressFrame = (
  deps: McpDispatchDeps,
  frame: McpProgressFrame,
  redactor: Redactor,
): Effect.Effect<void, McpTransportError> =>
  deps.notify === undefined
    ? Effect.void
    : encodeProgressFrame(frame, redactor).pipe(
        Effect.flatMap((encoded) => deps.notify?.(encoded) ?? Effect.void),
      );

/**
 * Dispatch a single MCP tool call. Resolves to the redacted command envelope, or
 * fails with an MCP-level error for calls that never reach the command.
 * Publishes `pre-mcp-call` before the decision and `post-mcp-call` after — for
 * every call, including rejected ones.
 */
export const dispatchTool = Effect.fn("McpService.dispatchTool")(function* (
  request: McpToolCallRequest,
  deps: McpDispatchDeps,
): Effect.fn.Return<McpDispatchResult, McpDispatchError> {
  const startedAt = yield* nowMs(deps);
  const appRef = appRefSummary(deps, request.input);
  const entry = deps.registry.get(request.toolId);
  const commandId = entry?.spec.id ?? request.toolId;

  yield* emit(deps, preEvent(deps, { toolId: request.toolId, commandId, appRef }, startedAt));

  const emitPost = Effect.fnUntraced(function* (
    outcome: "success" | "failure",
    failureDetail: string | undefined,
  ) {
    const now = yield* nowMs(deps);
    yield* emit(
      deps,
      postEvent(
        deps,
        {
          toolId: request.toolId,
          commandId,
          appRef,
          outcome,
          durationMs: now - startedAt,
          failureDetail,
        },
        now,
      ),
    );
  });

  const run: Effect.Effect<McpDispatchResult, McpDispatchError> = Effect.gen(function* () {
    if (deps.rejection !== undefined) return yield* Effect.fail(deps.rejection);
    const rejectNotAllowed = (): McpToolNotAllowedError =>
      new McpToolNotAllowedError({
        message: `Tool ${request.toolId} is not in the effective MCP allowlist.`,
        toolId: request.toolId,
        effectiveAllowlist: [...deps.effective].sort((a, b) => a.localeCompare(b)),
        source: deps.allowlistSource,
        remediation: `Add ${request.toolId} to \`mcp.allow\` (or --allow) to expose it as an MCP tool.`,
      });
    const unavailable = (): McpTransportError =>
      new McpTransportError({
        message: `Tool ${request.toolId} is not available in the active MCP registry.`,
        remediation:
          "Enable MCP tooling for tooling-backed ids, or remove the id from mcp.allow/--allow for this session.",
      });

    if (!deps.effective.has(request.toolId)) {
      const error = rejectNotAllowed();
      return yield* Effect.fail(error);
    }
    if (entry === undefined) {
      const error = unavailable();
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
    });

    const runInput: McpRunInput = {
      argv: [],
      flags: validated.flags,
      args: validated.args,
      interaction: "non-interactive",
      ...(request.input?.appPath === undefined ? {} : { appPath: request.input.appPath }),
    };

    const rawOutcome = yield* deps.execute(entry, runInput);
    const outcome = yield* inspectMcpCommandOutcome(rawOutcome);
    const tokens = Object.hasOwn(outcome, "value") ? (entry.spec.redactionTokens?.(outcome.value) ?? []) : [];
    const redactor = yield* deps.resultRedactor(tokens);
    const capture = deps.capture ?? new OutputCapture();
    capture.redactValues(tokens);
    if (Object.hasOwn(outcome, "value")) {
      for (const frame of entry.spec.streamFrames?.(outcome.value) ?? []) {
        yield* encodeProgressFrame(frame, redactor, capture);
        yield* emitProgressFrame(deps, frame, redactor);
      }
    }
    const encodedEnvelope = yield* buildCommandResultEnvelope({
      command: entry.spec.id,
      resultSchema: entry.spec.resultSchema,
      outcome,
      redactor,
    });
    const safeEnvelope = yield* redactBoundedJsonValue(encodedEnvelope, redactor, "MCP tool result");
    if (!Predicate.isObject(safeEnvelope))
      return yield* Effect.fail(
        new McpTransportError({
          message: "MCP command encoding did not produce an object envelope.",
          remediation: "Return a schema-valid command result.",
        }),
      );
    const withOutput = yield* Effect.try({
      try: () => capture.fitEnvelope(safeEnvelope, redactor),
      catch: (error) =>
        error instanceof McpTransportError
          ? error
          : new McpTransportError({
              message: "MCP final output could not be bounded safely.",
              remediation: "Return schema-valid bounded command data.",
            }),
    });
    const text = yield* stringifyBoundedJson(withOutput, "MCP tool result");
    const envelope: Schema.Json = JSON.parse(text);
    const ok = Predicate.isObject(envelope) && envelope.ok === true;
    yield* stringifyBoundedJson(
      { content: [{ type: "text", text }], structuredContent: envelope, isError: !ok },
      "MCP tool result frame",
    );

    yield* emitPost(ok ? "success" : "failure", ok ? undefined : envelopeTag(envelope));

    return { envelope, ok };
  });

  const exit = yield* Effect.exit(Effect.interruptible(run));
  if (exit._tag === "Success") return exit.value;
  if (Cause.hasInterruptsOnly(exit.cause)) {
    yield* emitPost("failure", "Interrupted");
    return yield* Effect.interrupt;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    yield* emitPost("failure", failure.value._tag);
    return yield* Effect.fail(failure.value);
  }
  const logger = yield* Effect.serviceOption(Logger);
  if (Option.isSome(logger)) {
    yield* logger.value
      .debug("MCP command defect", { cause: deps.redactor.redactString(Cause.pretty(exit.cause)) })
      .pipe(Effect.ignore);
  }
  const redactor = yield* deps.resultRedactor([]);
  const encoded = yield* buildCommandResultEnvelope({
    command: commandId,
    resultSchema: Schema.Unknown,
    outcome: failureOutcomeFromCause(exit.cause, normalizeDefect),
    redactor,
  });
  const safeEnvelope = yield* redactBoundedJsonValue(encoded, redactor, "MCP tool failure");
  if (!Predicate.isObject(safeEnvelope))
    return yield* Effect.fail(
      new McpTransportError({
        message: "MCP failure encoding did not produce an object envelope.",
        remediation: "Return a schema-valid command failure.",
      }),
    );
  const capture = deps.capture ?? new OutputCapture();
  const envelope: Schema.Json = JSON.parse(
    yield* stringifyBoundedJson(capture.fitEnvelope(safeEnvelope, redactor), "MCP tool failure"),
  );
  yield* emitPost("failure", envelopeTag(envelope));
  return { envelope, ok: false };
}, Effect.uninterruptible);
