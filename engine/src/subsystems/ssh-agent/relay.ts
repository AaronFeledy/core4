import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { type NetConnectOpts, type Socket, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshAgentTransportError } from "@lando/sdk/errors";
import type { AgentSocketUpstream } from "@lando/sdk/schema";

export type AgentRelayUpstream = AgentSocketUpstream | { readonly _tag: "named-pipe"; readonly path: string };
export interface AgentRelayOptions {
  readonly upstream: AgentRelayUpstream;
  readonly listen:
    | { readonly _tag: "unix"; readonly path: string; readonly mode: number }
    | { readonly _tag: "loopback-tcp"; readonly token?: string };
  readonly maxConnections?: number;
}
export interface AgentRelayHandle {
  readonly address:
    | { readonly _tag: "unix"; readonly path: string }
    | { readonly _tag: "loopback-tcp"; readonly port: number };
  readonly activeConnections: () => number;
  readonly close: () => Promise<void>;
}

export const agentTransportError = (message: string, cause?: unknown) =>
  new SshAgentTransportError({
    message,
    stage: "broker",
    remediation: "Check the host agent socket and restart the app to recreate its relay.",
    ...(cause === undefined ? {} : { cause }),
  });
export const makeAgentRelayToken = (): string => randomBytes(32).toString("base64url");

export const connectAgentUpstream = (
  upstream: AgentRelayUpstream,
  connector: (options: NetConnectOpts) => Socket = connect,
): Socket => {
  switch (upstream._tag) {
    case "unix":
    case "named-pipe":
      return connector({ path: upstream.path });
    case "loopback-tcp": {
      const socket = connector({ port: upstream.port, host: "127.0.0.1" });
      if (upstream.token !== undefined) socket.write(upstream.token);
      return socket;
    }
    default:
      return upstream satisfies never;
  }
};

export const agentRelayListenPath = (path: string, platform: string = process.platform): string =>
  platform === "darwin" && Buffer.byteLength(path) >= 100
    ? join(tmpdir(), `lando-agent-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`)
    : path;

const removeStaleSocket = async (path: string): Promise<void> => {
  const info = await lstat(path).catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (info === undefined) return;
  if (!info.isSocket()) throw agentTransportError("Refusing to replace a non-socket relay path.");
  const alive = await new Promise<boolean>((resolve, reject) => {
    const socket = connect({ path });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error) => {
      socket.destroy();
      if ("code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) resolve(false);
      else reject(error);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(true);
    });
  });
  if (alive) throw agentTransportError("Another relay already owns this socket.");
  const current = await lstat(path);
  if (current.ino !== info.ino || current.dev !== info.dev)
    throw agentTransportError("Relay socket ownership changed.");
  await unlink(path);
};

export const createAgentRelay = async (options: AgentRelayOptions): Promise<AgentRelayHandle> => {
  const clients = new Set<Socket>();
  const sockets = new Set<Socket>();
  const token = options.listen._tag === "loopback-tcp" ? options.listen.token : undefined;
  if (token !== undefined && !/^[\w-]{43}$/.test(token))
    throw agentTransportError("Relay tokens must encode 32 random bytes as base64url.");
  const server = createServer((client) => {
    if (clients.size >= (options.maxConnections ?? 128)) {
      client.destroy();
      return;
    }
    clients.add(client);
    sockets.add(client);
    client.once("close", () => {
      clients.delete(client);
      sockets.delete(client);
    });
    client.on("error", () => client.destroy());
    const forward = (head: Buffer) => {
      const upstream = connectAgentUpstream(options.upstream);
      sockets.add(upstream);
      upstream.once("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
      upstream.on("error", () => {
        upstream.destroy();
        client.destroy();
      });
      client.once("close", () => upstream.destroy());
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream).pipe(client);
    };
    if (token === undefined) {
      forward(Buffer.alloc(0));
      return;
    }
    let prefix = Buffer.alloc(0);
    client.setTimeout(2_000, () => client.destroy());
    const authenticate = (chunk: Buffer) => {
      const needed = 43 - prefix.length;
      prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
      if (prefix.length < 43) return;
      client.removeListener("data", authenticate);
      client.setTimeout(0);
      if (!timingSafeEqual(prefix, Buffer.from(token))) {
        client.destroy();
        return;
      }
      forward(chunk.subarray(needed));
    };
    client.on("data", authenticate);
  });
  const path = options.listen._tag === "unix" ? agentRelayListenPath(options.listen.path) : undefined;
  let owned: Awaited<ReturnType<typeof lstat>> | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const socket of sockets) socket.destroy();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (path !== undefined && owned !== undefined) {
        const current = await lstat(path).catch((cause: unknown) => {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;
          throw cause;
        });
        if (current?.ino === owned.ino && current.dev === owned.dev) await unlink(path);
      }
    })();
    return closing;
  };
  try {
    if (path !== undefined) await removeStaleSocket(path);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      if (path === undefined) server.listen(0, "127.0.0.1", resolve);
      else server.listen(path, resolve);
    });
    if (path !== undefined && options.listen._tag === "unix") {
      owned = await lstat(path);
      await chmod(path, options.listen.mode);
      return { address: { _tag: "unix", path }, activeConnections: () => clients.size, close };
    }
    const address = server.address();
    if (address === null || typeof address === "string")
      throw agentTransportError("Relay listener did not report a TCP port.");
    return {
      address: { _tag: "loopback-tcp", port: address.port },
      activeConnections: () => clients.size,
      close,
    };
  } catch (cause) {
    await close();
    throw cause instanceof SshAgentTransportError
      ? cause
      : agentTransportError("Unable to listen for agent connections.", cause);
  }
};
