import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type RootOverrides, makeLandoPaths } from "@lando/paths";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { SshError, causeMessage } from "@lando/sdk/errors";
import { runProbe } from "@lando/sdk/probe";
import {
  type AgentSocketBridgeResult,
  type AgentSocketKind,
  AppId,
  type AppRef,
  GPG_AGENT_SOCKET_NAME,
  type MountPlan,
  type PortablePath,
  SSH_AGENT_SOCKET_NAME,
  ServiceName,
} from "@lando/sdk/schema";
import { GlobalAppService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Duration, Effect, Option, Ref } from "effect";
import { probeSshAgent } from "./agent-probe.ts";
import type { AgentRelayUpstream } from "./relay.ts";

export const agentSocketMountPlan = (mount: AgentSocketBridgeResult, target: PortablePath): MountPlan => {
  switch (mount._tag) {
    case "bind-directory":
      return {
        type: "bind",
        source: mount.directory,
        target,
        readOnly: true,
        createHostPath: false,
        realization: "passthrough",
      };
    case "volume":
      return {
        type: "volume",
        source: mount.volume,
        target,
        readOnly: true,
        realization: "passthrough",
      };
    default:
      return mount satisfies never;
  }
};

export type SshSidecarState = "starting" | "stopped" | "ready";
export interface SshSidecarReadiness {
  readonly state: SshSidecarState;
  readonly detail?: string;
}

export const runtimeSshAgentCheck = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry))
    return { state: "stopped" as const, detail: "Runtime provider registry is unavailable." };
  const globalApp = yield* Effect.serviceOption(GlobalAppService);
  if (Option.isNone(globalApp))
    return { state: "starting" as const, detail: "Global app service is unavailable." };
  const provider = yield* registry.value.select(yield* globalApp.value.providerId);
  const target = { app: AppId.make("global"), service: ServiceName.make("ssh-agent") };
  const service = yield* provider.inspect(target);
  const status = service.state ?? service.status;
  if (status !== "running")
    return {
      state: status === "restarting" ? ("starting" as const) : ("stopped" as const),
      detail: `SSH agent sidecar container status: ${status}${service.exitCode === undefined ? "" : `; container exit code: ${service.exitCode}`}.`,
    };
  const result = yield* provider.exec(target, {
    command: ["sh", "-c", "ssh-add -l >/dev/null 2>&1; result=$?; test $result -eq 0 -o $result -eq 1"],
    stdin: "ignore",
  });
  return result.exitCode === 0
    ? { state: "ready" as const }
    : {
        state: "starting" as const,
        detail: `SSH readiness shell probe exited with code ${result.exitCode}.${result.stderr ? ` ${result.stderr}` : ""}`,
      };
}).pipe(
  // Covers provider select, inspect, and an exec round-trip; a Podman machine exec can exceed 2s.
  Effect.timeout("5 seconds"),
);

export const runtimeSshAgentState = runtimeSshAgentCheck.pipe(
  Effect.map(({ state }) => state),
  Effect.catch(() => Effect.succeed("starting" as const)),
);

export const sidecarSocketCheck = (upstream: AgentRelayUpstream, probe = probeSshAgent) =>
  runtimeSshAgentCheck.pipe(
    Effect.flatMap(
      (sidecar): Effect.Effect<SshSidecarReadiness, SshError> =>
        sidecar.state === "stopped"
          ? Effect.succeed(sidecar)
          : Effect.tryPromise({
              try: () => probe(upstream, { timeoutMs: 2_000 }),
              catch: (cause: unknown) =>
                new SshError({
                  sshId: "sidecar",
                  message:
                    cause instanceof Error && cause.cause !== undefined
                      ? `${cause.message} ${causeMessage(cause.cause)}`
                      : causeMessage(cause),
                  cause,
                }),
            }).pipe(Effect.as({ state: "ready" as const })),
    ),
  );

export const sidecarSocketState = (upstream: AgentRelayUpstream, probe = probeSshAgent) =>
  sidecarSocketCheck(upstream, probe).pipe(
    Effect.map(({ state }) => state),
    Effect.catch(() => Effect.succeed("starting" as const)),
  );

export const runtimeSshAgentReady = runtimeSshAgentState.pipe(Effect.map((state) => state === "ready"));

export const SSH_SIDECAR_READINESS_POLICY = {
  maxAttempts: 60,
  delay: Duration.millis(500),
  timeout: Duration.seconds(30),
} as const;

export const awaitRuntimeSshAgent = Effect.fnUntraced(function* (
  check: Effect.Effect<SshSidecarReadiness, unknown> = runtimeSshAgentCheck,
) {
  const lastState = yield* Ref.make<SshSidecarState>("starting");
  const lastFailure = yield* Ref.make<string | undefined>(undefined);
  const sourceEnv = process.env;
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(redaction)
    ? yield* redaction.value.forProfile("secrets", { sourceEnv })
    : createStandaloneRedactor("secrets", { sourceEnv });
  const result = yield* runProbe(
    {
      id: "ssh-sidecar-ready",
      policy: SSH_SIDECAR_READINESS_POLICY,
      // Green ends probing for both terminal states; the Ref preserves which terminal state won.
      classify: {
        success: (state) => (state === "starting" ? "yellow" : "green"),
        failure: () => "yellow",
      },
    },
    check.pipe(
      Effect.tap((value) =>
        Effect.all([
          Ref.set(lastState, value.state),
          value.detail === undefined
            ? Effect.void
            : Ref.set(lastFailure, redactor.redactString(value.detail)),
        ]),
      ),
      Effect.tapError((error) => Ref.set(lastFailure, redactor.redactString(causeMessage(error)))),
      Effect.map(({ state }) => state),
    ),
  ).pipe(Effect.catch((error) => Effect.succeed({ lastError: error })));
  const state = yield* Ref.get(lastState);
  const detail =
    (yield* Ref.get(lastFailure)) ??
    (result.lastError === undefined ? undefined : redactor.redactString(causeMessage(result.lastError)));
  return { state, ...(state === "ready" || detail === undefined ? {} : { detail }) };
});

export const sshAgentSessionPaths = (
  app: Pick<AppRef, "id" | "root">,
  paths: RootOverrides | undefined,
  kind: AgentSocketKind,
) => {
  const stateDir = makeLandoPaths(paths).agentRelayRunDir(kind, app.id, app.root);
  const socketDir = join(stateDir, "socket");
  return {
    stateDir,
    socketDir,
    socketPath: join(socketDir, kind === "ssh" ? SSH_AGENT_SOCKET_NAME : GPG_AGENT_SOCKET_NAME),
    recordPath: join(stateDir, "worker.json"),
  };
};

export interface AgentRelaySession {
  readonly appId: string;
  readonly sessionId: string;
  readonly kind: AgentSocketKind;
  readonly mount: AgentSocketBridgeResult;
  readonly socketName: string;
  readonly close: () => Promise<void>;
  readonly closed: Promise<void>;
}

export const AGENT_RELAY_DIRECTORY_MODE = 0o711;
export const AGENT_RELAY_SOCKET_MODE = 0o666;

export const AGENT_RELAY_RUN_ROOT_MODE = 0o700;

/** Parent of per-app relay state dirs. Kept private so 0666 relay sockets are not reachable by other host users. */
export const ensureAgentRelayRunRoot = async (stateDir: string): Promise<void> => {
  const runRoot = dirname(stateDir);
  await mkdir(runRoot, { recursive: true, mode: AGENT_RELAY_RUN_ROOT_MODE });
  await chmod(runRoot, AGENT_RELAY_RUN_ROOT_MODE);
};
