import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";

import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import type { EventError } from "@lando/sdk/errors";
import {
  type HostProxyRequestRedacted,
  PostHostProxyCallEvent,
  PreHostProxyCallEvent,
} from "@lando/sdk/events";
import {
  type AppPlan,
  type AppRef,
  CommandResultEnvelope,
  type HostProxyRunLandoRequest,
} from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService } from "@lando/sdk/services";
import type { ShellRunner } from "@lando/sdk/services";

import { OpenAppResultSchema, openForPlan } from "../../cli/commands/open.ts";
import { buildCommandResultEnvelope } from "../../cli/result-encode.ts";
import { RedactionService } from "../../redaction/service.ts";
import { type HostProxyMountInfo, remapContainerCwd } from "./cwd-remap.ts";
import { parseOpenOptionsFromRunLandoArgv } from "./open-argv.ts";
import { filterHostProxyEnv } from "./shim.ts";

/**
 * Host-side `runLando` dispatcher. It takes a container-forwarded `runLando`
 * request, enforces the host-proxy allowlist, remaps the container cwd to the
 * host app root, filters env, dispatches the command against the retained host
 * runtime, and publishes redacted `pre/post-host-proxy-call` lifecycle events
 * for every request (including rejected ones). The result is the same
 * `CommandResultEnvelope` + exit code the host-side command produces.
 *
 * This is the logical round-trip; the physical Unix-socket transport, token
 * auth, concurrency cap, and recursion guard belong to the broader host-proxy
 * transport wave.
 */

export interface HostProxyRunLandoExecutorInput {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
  /** Remapped host-side cwd. */
  readonly cwd: string;
  readonly tty: boolean;
  readonly env: Readonly<Record<string, string>>;
}

export interface HostProxyRunLandoResult {
  readonly envelope: CommandResultEnvelope;
  readonly exitCode: number;
}

/**
 * The seam that actually runs a host-side command for a `runLando` request and
 * returns its machine envelope + exit code. Production wiring dispatches against
 * a retained `LandoRuntime`; tests bind a fake executor.
 */
export type HostProxyRunLandoExecutor = (
  input: HostProxyRunLandoExecutorInput,
) => Effect.Effect<HostProxyRunLandoResult, never>;

export interface DispatchRunLandoDeps {
  readonly executor: HostProxyRunLandoExecutor;
  /** Effective host-proxy runLando allowlist (canonical ids). */
  readonly allowlist: ReadonlyArray<string>;
  readonly mountInfo: HostProxyMountInfo;
  readonly callerService: string;
  /** Host-proxy re-entry depth (`LANDO_HOST_PROXY_DEPTH`). */
  readonly depth: number;
  readonly app: AppRef;
  /** Optional stable call id; a timestamp-derived id is used when omitted. */
  readonly callId?: string;
}

/** Canonicalize the first argv token to a command id (mirrors `runOpen`). */
const commandIdFromArgv = (argv: ReadonlyArray<string>): string => {
  const head = argv[0] ?? "";
  if (head === "open" || head === "app:open") return "app:open";
  return head;
};

const now = () => DateTime.unsafeMake(new Date().toISOString());

const redactedRequestSummary = (
  request: HostProxyRunLandoRequest,
  commandId: string,
  hostCwd: string,
  redactor: Redactor,
): HostProxyRequestRedacted => ({
  kind: request._tag,
  commandId,
  argvSummary: request.argv.map((token) => redactor.redactString(token)),
  cwd: redactor.redactString(hostCwd),
});

const resultSummaryFor = (result: HostProxyRunLandoResult, redactor: Redactor): string =>
  redactor.redactString(`exit=${result.exitCode} ok=${result.envelope.ok}`);

export const dispatchRunLando = (
  request: HostProxyRunLandoRequest,
  deps: DispatchRunLandoDeps,
): Effect.Effect<
  HostProxyRunLandoResult,
  HostProxyCommandNotAllowedError | EventError,
  EventService | RedactionService
> =>
  Effect.gen(function* () {
    const events = yield* EventService;
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });

    const commandId = commandIdFromArgv(request.argv);
    const hostCwd = remapContainerCwd(request.cwd, deps.mountInfo);
    const callId = deps.callId ?? `hp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const summary = redactedRequestSummary(request, commandId, hostCwd, redactor);

    yield* events.publish(
      PreHostProxyCallEvent.make({
        app: deps.app,
        callId,
        request: summary,
        callerService: deps.callerService,
        depth: deps.depth,
        timestamp: now(),
      }),
    );

    if (!deps.allowlist.includes(commandId)) {
      const error = new HostProxyCommandNotAllowedError({
        message: `Command ${commandId} is not on the host-proxy runLando allowlist.`,
        commandId,
        effectiveAllowlist: [...deps.allowlist],
        remediation:
          "Only commands that declare `hostProxyAllowed: true` may be forwarded from a container through the runLando channel.",
      });
      yield* events.publish(
        PostHostProxyCallEvent.make({
          app: deps.app,
          callId,
          request: summary,
          callerService: deps.callerService,
          depth: deps.depth,
          outcome: "failure",
          failureDetail: error._tag,
          timestamp: now(),
        }),
      );
      return yield* Effect.fail(error);
    }

    const start = Date.now();
    const result = yield* deps.executor({
      commandId,
      argv: request.argv,
      cwd: hostCwd,
      tty: request.tty,
      env: request.env === undefined ? {} : filterHostProxyEnv(request.env),
    });

    yield* events.publish(
      PostHostProxyCallEvent.make({
        app: deps.app,
        callId,
        request: summary,
        callerService: deps.callerService,
        depth: deps.depth,
        outcome: result.envelope.ok ? "success" : "failure",
        durationMs: Date.now() - start,
        resultSummary: resultSummaryFor(result, redactor),
        timestamp: now(),
      }),
    );

    return result;
  });

const OPEN_COMMAND = "app:open" as const;

const redactCommandEnvelope = (envelope: CommandResultEnvelope, redactor: Redactor): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(redactor.redactValue(envelope));

export const runOpenForHostProxy = (
  plan: AppPlan,
  input: HostProxyRunLandoExecutorInput,
): Effect.Effect<HostProxyRunLandoResult, never, ShellRunner | EventService | RedactionService> =>
  Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const parsed = parseOpenOptionsFromRunLandoArgv(input.argv, { tty: input.tty });
    const encoded =
      parsed._tag === "failure"
        ? { outcome: { _tag: "failure" as const, error: parsed.error }, exitCode: 1 }
        : yield* Effect.gen(function* () {
            const outcome = yield* Effect.exit(openForPlan(plan, parsed.options));
            return Exit.isSuccess(outcome)
              ? { outcome: { _tag: "success" as const, value: outcome.value }, exitCode: 0 }
              : {
                  outcome: {
                    _tag: "failure" as const,
                    error: Option.getOrElse(Cause.failureOption(outcome.cause), () => ({
                      _tag: "HostProxyDispatchError",
                      message: Cause.pretty(outcome.cause),
                    })),
                  },
                  exitCode: 1,
                };
          });
    const envelope = yield* buildCommandResultEnvelope({
      command: OPEN_COMMAND,
      resultSchema: OpenAppResultSchema,
      outcome: encoded.outcome,
      redactor,
    });
    return { envelope: redactCommandEnvelope(envelope, redactor), exitCode: encoded.exitCode };
  });
