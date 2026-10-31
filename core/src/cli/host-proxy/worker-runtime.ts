import { cliRuntimeOptions } from "@lando/engine/runtime/cli-options";
import { ensureHostProxyNoProxy } from "@lando/engine/subsystems/host-proxy/proxy-bypass";
import { scopedHostProxyRunLandoSession } from "@lando/engine/subsystems/host-proxy/transport";
import { writeWorkerDiagnostic } from "@lando/engine/subsystems/host-proxy/worker-process";
import { hostProxyMountInfoFromPlan } from "@lando/engine/subsystems/host-proxy/worker-service-plan";
import { RedactionService, makeRedactionOwner } from "@lando/redaction/service";
import { detachStdioWrites, writeStdioLine } from "@lando/renderer/io";
import { AppPlan, type AppRef } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "../generated/host-proxy-allowlist";
import { hostProxyChildExecutor, hostProxyChildOpenExecutor } from "./call-spawn";
import { WorkerInput } from "./worker-config";

export const runHostProxyWorkerProcess = async (): Promise<void> => {
  ensureHostProxyNoProxy("127.0.0.1");
  ensureHostProxyNoProxy("localhost");
  const owner = makeRedactionOwner();
  const redactionLayer = Layer.succeed(RedactionService, owner.service);
  const shutdown = Promise.withResolvers<void>();
  const onSignal = () => shutdown.resolve();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    const input = await Effect.runPromise(
      Schema.decodeUnknownEffect(Schema.fromJsonString(WorkerInput))(await Bun.stdin.text()).pipe(
        Effect.mapError(() => new TypeError("Invalid host-proxy worker input.")),
      ),
    );
    const app = { kind: input.app.kind, id: input.plan.id, root: input.plan.root } satisfies AppRef;
    if (input.app.id !== app.id || input.app.root !== app.root)
      throw new TypeError("Host-proxy worker identity does not match its plan.");
    let plan = input.plan;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const bridgeState: { current: "none" | "alive" | "dead" } = { current: "none" };
          const session = yield* scopedHostProxyRunLandoSession({
            app,
            get mountInfo() {
              return hostProxyMountInfoFromPlan(plan);
            },
            allowlist: HOST_PROXY_RUNLANDO_ALLOWLIST,
            callerService: "lando",
            executor: hostProxyChildExecutor(input),
            openExecutor: hostProxyChildOpenExecutor(input),
            providerId: input.plan.provider,
            configure: async (body) => {
              const decoded = Schema.decodeUnknownResult(AppPlan)(body);
              if (
                decoded._tag === "Failure" ||
                decoded.success.id !== app.id ||
                decoded.success.root !== app.root ||
                decoded.success.provider !== input.plan.provider
              )
                throw new TypeError("Invalid host-proxy plan.");
              plan = decoded.success;
            },
            diagnostic: writeWorkerDiagnostic,
            paths: input.paths,
            shimArtifactPath: input.shimArtifactPath,
            configDigest: input.configDigest,
            bridgeState: () => bridgeState.current,
            ...(input.shimTarget === undefined ? {} : { shimTarget: input.shimTarget }),
            ...(input.hostGatewayName === undefined ? {} : { hostGatewayName: input.hostGatewayName }),
          });
          let bridge: { readonly socketPath: string; readonly exited: Promise<number> } | undefined;
          if (session.transport === "tcp-host-gateway" && session.url !== undefined) {
            const { makeLandoRuntime } = yield* Effect.promise(() => import("../../runtime/layer"));
            yield* Effect.promise(() => import("../../runtime/bundled-plugins"));
            // The bridge's provider runtime belongs to the worker, never to an executor generation.
            const context = yield* Layer.build(
              makeLandoRuntime(
                cliRuntimeOptions({
                  bootstrap: "provider",
                  cwd: input.plan.root,
                  config: input.paths,
                  plugins: { policy: "discovery" },
                  logLevel: "none",
                  telemetry: false,
                  installSignalHandlers: false,
                }),
              ).pipe(Layer.provide(redactionLayer)),
            );
            const provider = yield* Effect.provide(RuntimeProviderRegistry, context).pipe(
              Effect.flatMap((registry) => registry.select(input.plan)),
            );
            if (provider.openHostProxyBridge !== undefined) {
              bridge = yield* provider
                .openHostProxyBridge({
                  appId: input.plan.id,
                  sessionId: session.sessionId,
                  loopbackUrl: session.url,
                })
                .pipe(Effect.provide(context));
              bridgeState.current = "alive";
              void bridge.exited.then(
                () => {
                  bridgeState.current = "dead";
                },
                () => {
                  bridgeState.current = "dead";
                },
              );
            }
          }
          void session.closed.then(shutdown.resolve);
          yield* Effect.sync(() => {
            const socketPath = bridge?.socketPath ?? session.socketPath;
            writeStdioLine(
              "stdout",
              JSON.stringify({
                _tag: "ready",
                appId: session.appId,
                sessionId: session.sessionId,
                token: session.token,
                controlToken: session.controlToken,
                ...(socketPath === undefined ? {} : { socketPath }),
                ...(session.url === undefined ? {} : { url: session.url }),
                ...(bridge !== undefined || session.containerUrl === undefined
                  ? {}
                  : { containerUrl: session.containerUrl }),
                shimPath: session.shimPath,
                transport: bridge === undefined ? session.transport : "unix-socket",
              }),
            );
            detachStdioWrites();
          });
          yield* Effect.promise(() => shutdown.promise);
        }),
      ).pipe(Effect.provide(redactionLayer)),
    );
  } catch {
    // Bootstrap errors may contain decoded proxy credentials; report no payload or cause.
    throw new TypeError("Host-proxy worker bootstrap failed. Validate global configuration and retry.");
  } finally {
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
    owner.dispose();
  }
};
