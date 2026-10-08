import { Clock, DateTime, Effect } from "effect";

import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import type { EventError } from "@lando/sdk/errors";
import {
  type HostProxyRequestRedacted,
  PostHostProxyCallEvent,
  PreHostProxyCallEvent,
} from "@lando/sdk/events";
import type { AppRef, CommandResultEnvelope, HostProxyRunLandoRequest } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import { EventService } from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";
import { type HostProxyMountInfo, remapContainerCwd } from "./cwd-remap.ts";
import { filterHostProxyEnv } from "./shim.ts";

/**
 * Host-side `runLando` dispatcher. It takes a container-forwarded `runLando`
 * request, enforces the host-proxy allowlist, remaps the container cwd to the
 * host app root, filters env, dispatches the command against the retained host
 * runtime, and publishes redacted `pre/post-host-proxy-call` lifecycle events
 * for every request (including rejected ones). The result is the same
 * `CommandResultEnvelope` + exit code the host-side command produces.
 *
 * This module is the logical round-trip only. Socket/TCP transport, token auth,
 * concurrency admission, and recursion guards live in the transport modules.
 */

export interface HostProxyRunLandoExecutorInput {
  readonly commandId: string;
  readonly argv: ReadonlyArray<string>;
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
  readonly allowlist: ReadonlyArray<string>;
  readonly mountInfo: HostProxyMountInfo;
  readonly callerService: string;
  /** Host-proxy re-entry depth (`LANDO_HOST_PROXY_DEPTH`). */
  readonly depth: number;
  readonly app: AppRef;
  /** Optional stable call id; a timestamp-derived id is used when omitted. */
  readonly callId?: string;
  /** Resolved agent-context allowlist (built-in plus allow, minus deny). */
  readonly agentEnvAllowlist?: ReadonlyArray<string>;
}

const commandIdFromArgv = (argv: ReadonlyArray<string>): string => {
  const head = argv[0] ?? "";
  if (head === "open" || head === "app:open") return "app:open";
  return head;
};

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

const forwardedEnvFor = (
  request: HostProxyRunLandoRequest,
  depth: number,
  agentEnvAllowlist?: ReadonlyArray<string>,
): Readonly<Record<string, string>> => ({
  ...(request.env === undefined ? {} : filterHostProxyEnv(request.env, agentEnvAllowlist)),
  LANDO_HOST_PROXY_DEPTH: String(depth + 1),
});

export const dispatchRunLando = Effect.fn("HostProxyService.dispatchRunLando")(function* (
  request: HostProxyRunLandoRequest,
  deps: DispatchRunLandoDeps,
): Effect.fn.Return<
  HostProxyRunLandoResult,
  HostProxyCommandNotAllowedError | EventError,
  EventService | RedactionService
> {
  const events = yield* EventService;
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });

  const commandId = commandIdFromArgv(request.argv);
  const hostCwd = remapContainerCwd(request.cwd, deps.mountInfo);
  const callId =
    deps.callId ?? `hp-${yield* Clock.currentTimeMillis}-${Math.random().toString(36).slice(2, 10)}`;
  const summary = redactedRequestSummary(request, commandId, hostCwd, redactor);

  yield* events.publish(
    PreHostProxyCallEvent.make({
      app: deps.app,
      callId,
      request: summary,
      callerService: deps.callerService,
      depth: deps.depth,
      timestamp: yield* DateTime.now,
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
        timestamp: yield* DateTime.now,
      }),
    );
    return yield* Effect.fail(error);
  }

  const start = yield* Clock.currentTimeMillis;
  const result = yield* deps.executor({
    commandId,
    argv: request.argv,
    cwd: hostCwd,
    tty: request.tty,
    env: forwardedEnvFor(request, deps.depth, deps.agentEnvAllowlist),
  });

  yield* events.publish(
    PostHostProxyCallEvent.make({
      app: deps.app,
      callId,
      request: summary,
      callerService: deps.callerService,
      depth: deps.depth,
      outcome: result.envelope.ok ? "success" : "failure",
      durationMs: (yield* Clock.currentTimeMillis) - start,
      resultSummary: resultSummaryFor(result, redactor),
      timestamp: yield* DateTime.now,
    }),
  );

  return result;
});
