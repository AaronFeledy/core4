import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type RootOverrides, makeLandoPaths } from "@lando/paths";
import {
  type AgentSocketBridgeResult,
  type AgentSocketKind,
  type AppRef,
  GPG_AGENT_SOCKET_NAME,
  SSH_AGENT_SOCKET_NAME,
} from "@lando/sdk/schema";

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
