import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, ProviderId } from "@lando/sdk/schema";
import { Schema } from "effect";
import type { DetachedAgentRelayWorkerOptions } from "../../../src/subsystems/ssh-agent/detached-worker.ts";
import { sshAgentSessionPaths } from "../../../src/subsystems/ssh-agent/session.ts";
import {
  AgentRelayWorkerInput,
  AgentRelayWorkerReady,
} from "../../../src/subsystems/ssh-agent/worker-protocol.ts";

export const relayHarness = async (
  kind: "ssh" | "gpg",
  delivery: "bind-directory" | "guest-bridge" | "volume-relay",
) => {
  const root = await mkdtemp(join(tmpdir(), "relay-reuse-"));
  const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(root) };
  const state: {
    spawned: number;
    terminated: number;
    alive: boolean;
    ready: AgentRelayWorkerReady | undefined;
  } = {
    spawned: 0,
    terminated: 0,
    alive: true,
    ready: undefined,
  };
  const paths = { userDataRoot: root };
  const sessionPaths = sshAgentSessionPaths(app, paths, kind);
  const endpoints = new Set<Server>();
  const closeEndpoints = async () => {
    for (const server of endpoints) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      endpoints.delete(server);
    }
  };
  const options = {
    app,
    plan: { id: AppId.make(app.id), provider: ProviderId.make("lando") },
    paths,
    kind,
    delivery,
    socketName: "agent.sock",
    upstream: { _tag: "unix" as const, path: "/upstream/agent" },
    privateFileAccess: { enforce: async (path: string) => chmod(path, 0o600), verify: async () => undefined },
    isAlive: () => state.alive,
    identify: async () => {
      if (state.ready === undefined) throw new Error("No ready worker");
      return state.ready;
    },
    terminateProcess: async () => {
      await closeEndpoints();
      state.terminated++;
      state.alive = false;
    },
    spawnWorker: (spec: Parameters<NonNullable<DetachedAgentRelayWorkerOptions["spawnWorker"]>>[0]) => {
      state.spawned++;
      state.alive = true;
      let input: AgentRelayWorkerInput;
      return {
        pid: 987654,
        logPath: join(root, "worker.log"),
        argv: spec.argv,
        writeStdin: async (text: string) => {
          input = Schema.decodeUnknownSync(AgentRelayWorkerInput)(JSON.parse(text));
        },
        readReady: async () => {
          const workerPaths = sshAgentSessionPaths(input.app, input.paths, kind);
          await mkdir(workerPaths.socketDir, { recursive: true, mode: 0o700 });
          await closeEndpoints();
          const endpoint = join(workerPaths.socketDir, input.socketName);
          await rm(endpoint, { force: true });
          const server = createServer();
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(endpoint, resolve);
          });
          endpoints.add(server);
          await chmod(endpoint, 0o666);
          const ready = {
            _tag: "ready" as const,
            appId: input.app.id,
            appRoot: input.app.root,
            kind,
            sessionId: `session-${state.spawned}`,
            pid: 987654,
            protocolVersion: 2,
            configDigest: input.configDigest,
            controlToken: `secret-${state.spawned}`,
            controlPort: 12345,
            socketName: input.socketName,
            mount:
              delivery === "volume-relay"
                ? { _tag: "volume" as const, volume: "relay" }
                : { _tag: "bind-directory" as const, directory: AbsolutePath.make(workerPaths.socketDir) },
          };
          state.ready = Schema.decodeUnknownSync(AgentRelayWorkerReady)(ready);
          return state.ready;
        },
        terminate: async () => {
          await closeEndpoints();
          state.terminated++;
          state.alive = false;
        },
      };
    },
  };
  const cleanup = async () => {
    await closeEndpoints();
    await rm(root, { recursive: true, force: true });
  };
  return { root, options, state, sessionPaths, cleanup, closeEndpoints };
};
