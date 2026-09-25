import { timingSafeEqual } from "node:crypto";
import { type Socket, connect, createServer } from "node:net";
import { SshAgentTransportError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AgentSocketBridgeResult,
  AgentSocketDelivery,
  AgentSocketKind,
  AgentSocketUpstream,
  AppId,
  PortNumber,
  ProviderId,
} from "@lando/sdk/schema";
import { Schema } from "effect";

export const AGENT_RELAY_WORKER_COMMAND = "__internal:agent-relay-worker";
export const AGENT_RELAY_WORKER_PROTOCOL_VERSION = 1;
export const AgentRelayWorkerInput = Schema.Struct({
  app: Schema.Struct({ kind: Schema.Literal("user", "scratch"), id: Schema.String, root: AbsolutePath }),
  plan: Schema.Struct({ id: AppId, provider: ProviderId }),
  kind: AgentSocketKind,
  upstream: Schema.Union(AgentSocketUpstream, Schema.TaggedStruct("named-pipe", { path: Schema.String })),
  delivery: AgentSocketDelivery,
  socketName: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)),
  paths: Schema.Struct({
    userConfRoot: Schema.optional(Schema.String),
    userCacheRoot: Schema.optional(Schema.String),
    userDataRoot: Schema.optional(Schema.String),
    systemPluginRoot: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
  }),
  token: Schema.optional(Schema.String),
});
export type AgentRelayWorkerInput = typeof AgentRelayWorkerInput.Type;

export const AgentRelayWorkerIdentity = Schema.Struct({
  appId: Schema.String,
  appRoot: AbsolutePath,
  sessionId: Schema.String,
  kind: AgentSocketKind,
  protocolVersion: Schema.Literal(1),
  pid: Schema.Number.pipe(Schema.int(), Schema.positive()),
});
export type AgentRelayWorkerIdentity = typeof AgentRelayWorkerIdentity.Type;
export const AgentRelayWorkerReady = Schema.TaggedStruct("ready", {
  ...AgentRelayWorkerIdentity.fields,
  controlToken: Schema.String,
  controlPort: PortNumber,
  socketName: Schema.String,
  mount: AgentSocketBridgeResult,
});
export type AgentRelayWorkerReady = typeof AgentRelayWorkerReady.Type;
export const AgentRelayWorkerRecord = Schema.Struct({
  ...AgentRelayWorkerIdentity.fields,
  controlToken: Schema.String,
  controlPort: PortNumber,
  socketName: Schema.String,
  mount: AgentSocketBridgeResult,
});
export type AgentRelayWorkerRecord = typeof AgentRelayWorkerRecord.Type;

const controlError = () =>
  new SshAgentTransportError({
    message: "Agent relay worker ownership could not be verified.",
    stage: "worker",
    remediation: "Stop the owning app or inspect its relay worker before replacing this session.",
  });

export const identifyAgentRelayWorker = (record: AgentRelayWorkerRecord): Promise<AgentRelayWorkerIdentity> =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: record.controlPort });
    let text = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(controlError());
    }, 1_000);
    socket.once("connect", () => socket.write(`${record.controlToken}\n`));
    socket.once("error", () => reject(controlError()));
    socket.once("close", () => {
      clearTimeout(timeout);
      reject(controlError());
    });
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 16_384) {
        socket.destroy();
        reject(controlError());
        return;
      }
      const newline = text.indexOf("\n");
      if (newline < 0) return;
      try {
        resolve(Schema.decodeUnknownSync(AgentRelayWorkerIdentity)(JSON.parse(text.slice(0, newline))));
      } catch (cause) {
        reject(cause instanceof Error ? cause : controlError());
      } finally {
        clearTimeout(timeout);
        socket.destroy();
      }
    });
  });

export const createAgentRelayWorkerControl = async (
  identity: AgentRelayWorkerIdentity,
  controlToken: string,
) => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(1_000, () => socket.destroy());
    let token = "";
    socket.on("data", (chunk: Buffer) => {
      token += chunk.toString("utf8");
      if (Buffer.byteLength(token) > Buffer.byteLength(controlToken) + 1) {
        socket.destroy();
        return;
      }
      if (!token.endsWith("\n")) return;
      const actual = Buffer.from(token.slice(0, -1));
      const expected = Buffer.from(controlToken);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        socket.destroy();
        return;
      }
      socket.end(`${JSON.stringify(Schema.encodeSync(AgentRelayWorkerIdentity)(identity))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw controlError();
  }
  return {
    controlPort: PortNumber.make(address.port),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
};
