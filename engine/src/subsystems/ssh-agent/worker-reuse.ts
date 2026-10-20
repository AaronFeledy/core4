import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AppRef } from "@lando/sdk/schema";
import { Effect } from "effect";
import { isOwnerOnlyRecordFile } from "../detached-worker/state-file.ts";
import type { AgentRelaySession } from "./session.ts";
import { sshAgentSessionPaths } from "./session.ts";
import { AGENT_RELAY_WORKER_PROTOCOL_VERSION, identifyAgentRelayWorker } from "./worker-protocol.ts";
import {
  type TerminateAgentRelayWorkerOptions,
  agentRelayWorkerProcessAlive,
  disposeAgentRelayWorker,
  readAgentRelayWorkerRecord,
  registerAgentRelayControlToken,
  withAgentRelayWorkerLock,
} from "./worker-state.ts";

export const reuseAgentRelayWorker = Effect.fnUntraced(
  function* (
    app: Pick<AppRef, "id" | "root">,
    options: TerminateAgentRelayWorkerOptions,
    configDigest: string,
  ) {
    const record = yield* readAgentRelayWorkerRecord(app, options);
    if (record === undefined) return undefined;
    yield* registerAgentRelayControlToken(record.controlToken);
    if (
      !(yield* isOwnerOnlyRecordFile(
        sshAgentSessionPaths(app, options.paths, options.kind).recordPath,
        options.privateFileAccess,
      ))
    )
      return undefined;
    if (
      record.appId !== app.id ||
      record.appRoot !== app.root ||
      record.kind !== options.kind ||
      record.configDigest !== configDigest
    )
      return undefined;
    if (!(yield* Effect.try(() => (options.isAlive ?? agentRelayWorkerProcessAlive)(record.pid))))
      return undefined;
    const identity = yield* Effect.tryPromise(() => (options.identify ?? identifyAgentRelayWorker)(record));
    if (
      identity.appId !== app.id ||
      identity.appRoot !== app.root ||
      identity.kind !== options.kind ||
      identity.sessionId !== record.sessionId ||
      identity.pid !== record.pid ||
      identity.protocolVersion !== AGENT_RELAY_WORKER_PROTOCOL_VERSION ||
      identity.configDigest !== configDigest
    )
      return undefined;
    switch (record.mount._tag) {
      case "bind-directory": {
        const endpoint = join(record.mount.directory, record.socketName);
        const metadata = yield* Effect.tryPromise(() => lstat(endpoint));
        if (!metadata.isSocket() || metadata.uid !== process.getuid?.()) return undefined;
        break;
      }
      case "volume":
        break;
      default:
        return record.mount satisfies never;
    }
    let closePromise: Promise<void> | undefined;
    const closed = Promise.withResolvers<void>();
    return {
      appId: record.appId,
      sessionId: record.sessionId,
      kind: record.kind,
      socketName: record.socketName,
      mount: record.mount,
      closed: closed.promise,
      close: () => {
        closePromise ??= Effect.runPromise(
          withAgentRelayWorkerLock(
            app,
            options,
            Effect.gen(function* () {
              const current = yield* readAgentRelayWorkerRecord(app, options);
              if (current?.sessionId === record.sessionId && current.pid === record.pid)
                yield* disposeAgentRelayWorker(app, options);
            }),
          ),
        ).finally(closed.resolve);
        return closePromise;
      },
    } satisfies AgentRelaySession;
  },
  Effect.catch(() => Effect.succeed(undefined)),
);
