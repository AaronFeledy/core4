import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { remapContainerCwd } from "@lando/engine/subsystems/host-proxy/api";
import { makeAppDiscoveryResolver } from "@lando/landofile/traversal-policy";
import { RedactionService } from "@lando/redaction/service";
import { HostProxyCommandNotAllowedError } from "@lando/sdk/errors";
import { PostHostProxyCallEvent, PreHostProxyCallEvent } from "@lando/sdk/events";
import { AppRef } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Clock, DateTime, Effect, Exit, Schema } from "effect";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../generated/host-proxy-allowlist";

export const HOST_PROXY_CALL_COMMAND = "__internal:host-proxy-call";
const callFields = {
  app: AppRef,
  mount: Schema.Struct({ containerRoot: Schema.String, hostRoot: Schema.String }),
  cwd: Schema.String,
  callId: Schema.String,
  depth: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(3)),
  callerService: Schema.String,
};
export const HostProxyCall = Schema.Union([
  Schema.Struct({
    ...callFields,
    operation: Schema.Literal("runLando"),
    argv: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({ ...callFields, operation: Schema.Literal("openUrl"), url: Schema.String }),
  Schema.Struct({ ...callFields, operation: Schema.Literal("openPath"), path: Schema.String }),
]);
export type HostProxyCall = typeof HostProxyCall.Type;
export type HostProxyLandoCall = Extract<HostProxyCall, { readonly operation: "runLando" }>;

export const hostProxyDenied = (commandId: string) =>
  new HostProxyCommandNotAllowedError({
    message: "This command is not allowed through the host proxy.",
    commandId,
    effectiveAllowlist: [...HOST_PROXY_RUNLANDO_ALLOWLIST],
    remediation: "Use an allowlisted built-in command from the session app.",
  });

export const hostProxyCallCwd = async (call: HostProxyCall): Promise<string> => {
  const root = await realpath(call.app.root);
  const cwd = await realpath(remapContainerCwd(call.cwd, call.mount)).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return root;
    throw cause;
  });
  const rel = relative(root, cwd);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel))
    throw hostProxyDenied("cli:app-context");
  return cwd;
};

/** The app discovered from the process cwd must be the session app, so a symlink or nested Landofile cannot retarget a call. */
export const assertHostProxyAppContext = async (call: HostProxyLandoCall, cwd: string): Promise<void> => {
  const discovered = await makeAppDiscoveryResolver().resolve(cwd);
  if (
    discovered.kind !== "found" ||
    (await realpath(discovered.directory)) !== (await realpath(call.app.root))
  )
    throw hostProxyDenied("cli:app-context");
};

export const withHostProxyCall = Effect.fnUntraced(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
  call: HostProxyLandoCall,
  commandId: string,
) {
  const events = yield* EventService;
  const redactor = yield* (yield* RedactionService).forProfile("secrets", { sourceEnv: process.env });
  const common = {
    app: call.app,
    callId: call.callId,
    callerService: redactor.redactString(call.callerService),
    depth: call.depth,
    request: { kind: "runLando", commandId, cwd: redactor.redactString(process.cwd()) },
  };
  const started = yield* Clock.currentTimeMillis;
  yield* events.publish(PreHostProxyCallEvent.make({ ...common, timestamp: yield* DateTime.now }));
  return yield* operation.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        yield* events.publish(
          PostHostProxyCallEvent.make({
            ...common,
            timestamp: yield* DateTime.now,
            durationMs: (yield* Clock.currentTimeMillis) - started,
            outcome: Exit.isSuccess(exit) ? "success" : "failure",
          }),
        );
      }),
    ),
  );
});
