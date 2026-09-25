import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import {
  type AgentRelayOptions,
  createAgentRelay,
  makeAgentRelayToken,
} from "@lando/engine/subsystems/ssh-agent/relay";
import {
  AGENT_RELAY_DIRECTORY_MODE,
  AGENT_RELAY_SOCKET_MODE,
  sshAgentSessionPaths,
} from "@lando/engine/subsystems/ssh-agent/session";
import {
  AGENT_RELAY_WORKER_PROTOCOL_VERSION,
  type AgentRelayWorkerIdentity,
  AgentRelayWorkerInput,
  AgentRelayWorkerReady,
  createAgentRelayWorkerControl,
} from "@lando/engine/subsystems/ssh-agent/worker-protocol";
import type { RootOverrides } from "@lando/paths";
import { detachStdioWrites, writeStdioLine } from "@lando/renderer/io";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { AbsolutePath, AgentSocketUpstream, type AppPlan } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { DateTime, Effect, type Layer, Match, Schema } from "effect";

export interface AgentRelayWorkerOptions {
  readonly platform?: string;
  readonly createRelay?: typeof createAgentRelay;
}

const workerError = (stage: "worker" | "broker" | "bridge") => (_cause: unknown) =>
  new SshAgentTransportError({
    message: `Unable to start the agent relay ${stage}.`,
    stage,
    remediation: "Check the agent socket and provider bridge, then restart the app.",
  });

export const scopedAgentRelayWorker = (input: AgentRelayWorkerInput, options: AgentRelayWorkerOptions = {}) =>
  Effect.gen(function* () {
    const roots: RootOverrides = {
      ...(input.paths.userConfRoot === undefined ? {} : { userConfRoot: input.paths.userConfRoot }),
      ...(input.paths.userCacheRoot === undefined ? {} : { userCacheRoot: input.paths.userCacheRoot }),
      ...(input.paths.userDataRoot === undefined ? {} : { userDataRoot: input.paths.userDataRoot }),
      ...(input.paths.systemPluginRoot === undefined
        ? {}
        : { systemPluginRoot: input.paths.systemPluginRoot }),
      ...(input.paths.platform === undefined ? {} : { platform: input.paths.platform }),
    };
    const paths = sshAgentSessionPaths(input.app, roots, input.kind);
    const token = input.delivery === "volume-relay" ? (input.token ?? makeAgentRelayToken()) : undefined;
    const listen: AgentRelayOptions["listen"] = Match.value(input.delivery).pipe(
      Match.when("volume-relay", () => ({
        _tag: "loopback-tcp" as const,
        ...(token === undefined ? {} : { token }),
      })),
      Match.when("guest-bridge", () =>
        (options.platform ?? process.platform) === "win32"
          ? { _tag: "loopback-tcp" as const }
          : {
              _tag: "unix" as const,
              path: join(paths.socketDir, input.socketName),
              mode: AGENT_RELAY_SOCKET_MODE,
            },
      ),
      Match.when("bind-directory", () => ({
        _tag: "unix" as const,
        path: join(paths.socketDir, input.socketName),
        mode: AGENT_RELAY_SOCKET_MODE,
      })),
      Match.exhaustive,
    );
    if (listen._tag === "unix") {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(paths.socketDir, { recursive: true, mode: AGENT_RELAY_DIRECTORY_MODE });
          await chmod(paths.stateDir, AGENT_RELAY_DIRECTORY_MODE);
          await chmod(paths.socketDir, AGENT_RELAY_DIRECTORY_MODE);
        },
        catch: workerError("broker"),
      });
    }
    const relay = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => (options.createRelay ?? createAgentRelay)({ upstream: input.upstream, listen }),
        catch: workerError("broker"),
      }),
      (handle) => Effect.promise(() => handle.close()),
    );
    const identity: AgentRelayWorkerIdentity = {
      appId: input.app.id,
      appRoot: input.app.root,
      sessionId: randomUUID(),
      kind: input.kind,
      protocolVersion: AGENT_RELAY_WORKER_PROTOCOL_VERSION,
      pid: process.pid,
    };
    const mount = yield* Match.value(input.delivery).pipe(
      Match.when("bind-directory", () =>
        Effect.gen(function* () {
          if (
            relay.address._tag !== "unix" ||
            relay.address.path !== join(paths.socketDir, input.socketName)
          ) {
            return yield* Effect.fail(workerError("broker")(undefined));
          }
          return { _tag: "bind-directory" as const, directory: AbsolutePath.make(paths.socketDir) };
        }),
      ),
      Match.whenOr("guest-bridge", "volume-relay", () =>
        Effect.gen(function* () {
          const registry = yield* RuntimeProviderRegistry;
          const plan: AppPlan = {
            ...input.plan,
            name: input.app.id,
            slug: input.app.id,
            root: input.app.root,
            services: {},
            routes: [],
            networks: [],
            stores: [],
            fileSync: [],
            extensions: {},
            metadata: { resolvedAt: DateTime.unsafeNow(), source: input.app.root, runtime: 4 },
          };
          const provider = yield* registry.select(plan).pipe(Effect.mapError(workerError("bridge")));
          if (provider.openAgentSocketBridge === undefined)
            return yield* Effect.fail(workerError("bridge")(undefined));
          const upstream = yield* Schema.decodeUnknown(AgentSocketUpstream)({
            ...relay.address,
            ...(token === undefined ? {} : { token }),
          }).pipe(Effect.mapError(workerError("broker")));
          return yield* provider
            .openAgentSocketBridge({
              appId: input.plan.id,
              appRoot: input.app.root,
              sessionId: identity.sessionId,
              kind: input.kind,
              upstream,
              socketName: input.socketName,
            })
            .pipe(Effect.mapError(workerError("bridge")));
        }),
      ),
      Match.exhaustive,
    );
    const controlToken = makeAgentRelayToken();
    const control = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => createAgentRelayWorkerControl(identity, controlToken),
        catch: workerError("worker"),
      }),
      (handle) => Effect.promise(() => handle.close()),
    );
    return AgentRelayWorkerReady.make({
      _tag: "ready",
      ...identity,
      controlToken,
      controlPort: control.controlPort,
      socketName: input.socketName,
      mount,
    });
  });

export const runAgentRelayWorkerProcess = async (
  options: AgentRelayWorkerOptions & {
    readonly runtime?: Layer.Layer<RuntimeProviderRegistry, unknown>;
  } = {},
): Promise<void> => {
  const shutdown = Promise.withResolvers<void>();
  const onSignal = () => shutdown.resolve();
  const signals: NodeJS.EventEmitter = process;
  signals.once("SIGTERM", onSignal);
  signals.once("SIGINT", onSignal);
  try {
    const input = await Effect.runPromise(
      Schema.decodeUnknown(Schema.parseJson(AgentRelayWorkerInput))(await Bun.stdin.text()).pipe(
        Effect.mapError(workerError("worker")),
      ),
    );
    const run = Effect.scoped(
      Effect.gen(function* () {
        const ready = yield* scopedAgentRelayWorker(input, options);
        yield* Effect.sync(() => {
          writeStdioLine("stdout", JSON.stringify(Schema.encodeSync(AgentRelayWorkerReady)(ready)));
          detachStdioWrites();
        });
        yield* Effect.promise(() => shutdown.promise);
      }),
    );
    if (options.runtime !== undefined) {
      await Effect.runPromise(
        run.pipe(Effect.provide(options.runtime), Effect.raceFirst(Effect.promise(() => shutdown.promise))),
      );
    } else {
      const { makeLandoRuntime } = await import("../../runtime/layer");
      const runtime = makeLandoRuntime(
        cliRuntimeOptions({
          bootstrap: "provider",
          cwd: input.app.root,
          plugins: { policy: "discovery" },
          logLevel: "none",
          telemetry: false,
          installSignalHandlers: false,
          config: {
            ...(input.paths.userConfRoot === undefined
              ? {}
              : { userConfRoot: AbsolutePath.make(input.paths.userConfRoot) }),
            ...(input.paths.userDataRoot === undefined
              ? {}
              : { userDataRoot: AbsolutePath.make(input.paths.userDataRoot) }),
            ...(input.paths.userCacheRoot === undefined
              ? {}
              : { userCacheRoot: AbsolutePath.make(input.paths.userCacheRoot) }),
            ...(input.paths.systemPluginRoot === undefined
              ? {}
              : { systemPluginRoot: AbsolutePath.make(input.paths.systemPluginRoot) }),
          },
        }),
      );
      await Effect.runPromise(
        run.pipe(Effect.provide(runtime), Effect.raceFirst(Effect.promise(() => shutdown.promise))),
      );
    }
  } finally {
    signals.removeListener("SIGTERM", onSignal);
    signals.removeListener("SIGINT", onSignal);
  }
};
