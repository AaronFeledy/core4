import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type RootOverrides, makeLandoPaths } from "@lando/paths";
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
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Duration, Effect, Option, Ref } from "effect";
import { MANAGED_PROVIDER_SELECT_PLAN } from "../../providers/managed.ts";

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

export const runtimeSshAgentState = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) return "stopped" as const;
  const provider = yield* registry.value.select(MANAGED_PROVIDER_SELECT_PLAN);
  const target = { app: AppId.make("global"), service: ServiceName.make("ssh-agent") };
  const service = yield* provider.inspect(target);
  const status = service.state ?? service.status;
  if (status === "restarting") return "starting" as const;
  if (status !== "running") return "stopped" as const;
  const result = yield* provider.exec(target, {
    command: ["sh", "-c", "ssh-add -l >/dev/null 2>&1; result=$?; test $result -eq 0 -o $result -eq 1"],
    stdin: "ignore",
  });
  return result.exitCode === 0 ? ("ready" as const) : ("starting" as const);
}).pipe(
  // Covers provider select, inspect, and an exec round-trip; a Podman machine exec can exceed 2s.
  Effect.timeout("5 seconds"),
  // Only an observed non-running container is "stopped"; a failed or slow probe proves nothing yet.
  Effect.catch(() => Effect.succeed("starting" as const)),
);

export const runtimeSshAgentReady = runtimeSshAgentState.pipe(Effect.map((state) => state === "ready"));

export const SSH_SIDECAR_READINESS_POLICY = {
  maxAttempts: 60,
  delay: Duration.millis(500),
  timeout: Duration.seconds(30),
} as const;

export type SshSidecarState = Effect.Success<typeof runtimeSshAgentState>;

export const awaitRuntimeSshAgent = Effect.fnUntraced(function* (
  check: Effect.Effect<SshSidecarState> = runtimeSshAgentState,
) {
  const lastState = yield* Ref.make<SshSidecarState>("starting");
  yield* runProbe(
    {
      id: "ssh-sidecar-ready",
      policy: SSH_SIDECAR_READINESS_POLICY,
      // Green ends probing for both terminal states; the Ref preserves which terminal state won.
      classify: { success: (state) => (state === "starting" ? "yellow" : "green"), failure: () => "yellow" },
    },
    check.pipe(Effect.tap((state) => Ref.set(lastState, state))),
  ).pipe(Effect.catch(() => Effect.void));
  return yield* Ref.get(lastState);
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
