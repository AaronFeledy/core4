import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type RootOverrides, makeLandoPaths } from "@lando/paths";
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
import { Effect, Option } from "effect";
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

export const runtimeSshAgentReady = Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(RuntimeProviderRegistry);
  if (Option.isNone(registry)) return false;
  const provider = yield* registry.value.select(MANAGED_PROVIDER_SELECT_PLAN);
  const target = { app: AppId.make("global"), service: ServiceName.make("ssh-agent") };
  const service = yield* provider.inspect(target);
  if ((service.state ?? service.status) !== "running") return false;
  const result = yield* provider.exec(target, {
    command: ["sh", "-c", "ssh-add -l >/dev/null 2>&1; result=$?; test $result -eq 0 -o $result -eq 1"],
    stdin: "ignore",
  });
  return result.exitCode === 0;
}).pipe(
  // Covers provider select, inspect, and an exec round-trip; a Podman machine exec can exceed 2s.
  Effect.timeout("5 seconds"),
  Effect.catch(() => Effect.succeed(false)),
);

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
