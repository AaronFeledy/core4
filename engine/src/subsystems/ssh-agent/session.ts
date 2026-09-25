import { join } from "node:path";
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
