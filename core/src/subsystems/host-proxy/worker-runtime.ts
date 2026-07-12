import { stdout } from "node:process";
import { Effect, Schema } from "effect";

import { AppPlan, type AppRef } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import type { RootOverrides } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "./api.ts";
import { runOpenForHostProxy } from "./dispatch.ts";
import { ensureHostProxyNoProxy } from "./proxy-bypass.ts";
import { createHostProxyRunLandoSession } from "./transport.ts";
import { stdinText } from "./worker-process.ts";
import { hostProxyMountInfoFromPlan } from "./worker-service-plan.ts";

const WorkerInput = Schema.Struct({
  app: Schema.Struct({
    kind: Schema.Literal("user", "scratch"),
    id: Schema.String,
    root: Schema.String,
  }),
  plan: AppPlan,
  paths: Schema.Struct({
    userConfRoot: Schema.optional(Schema.String),
    userCacheRoot: Schema.optional(Schema.String),
    userDataRoot: Schema.optional(Schema.String),
    systemPluginRoot: Schema.optional(Schema.String),
    platform: Schema.optional(Schema.String),
  }),
  shimArtifactPath: Schema.String,
  shimTarget: Schema.optional(
    Schema.Union(
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("x64") }),
      Schema.Struct({ os: Schema.Literal("linux"), arch: Schema.Literal("arm64") }),
    ),
  ),
  hostGatewayName: Schema.optional(Schema.String),
});
type WorkerInput = typeof WorkerInput.Type;

const rootOverridesFromWorkerInput = (paths: WorkerInput["paths"]): RootOverrides => ({
  ...(paths.userConfRoot === undefined ? {} : { userConfRoot: paths.userConfRoot }),
  ...(paths.userCacheRoot === undefined ? {} : { userCacheRoot: paths.userCacheRoot }),
  ...(paths.userDataRoot === undefined ? {} : { userDataRoot: paths.userDataRoot }),
  ...(paths.systemPluginRoot === undefined ? {} : { systemPluginRoot: paths.systemPluginRoot }),
  ...(paths.platform === undefined ? {} : { platform: paths.platform }),
});

export const runHostProxyWorkerProcess = async (): Promise<void> => {
  ensureHostProxyNoProxy("127.0.0.1");
  ensureHostProxyNoProxy("localhost");
  const input = Schema.decodeUnknownSync(WorkerInput)(JSON.parse(await stdinText()));
  const app = { kind: input.app.kind, id: input.app.id, root: input.app.root } as AppRef;
  const runtime = makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }));
  // Runtime Layer scope must outlive session create (EventService is Layer.scoped).
  await Effect.runPromise(
    Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<ShellRunner | EventService | RedactionService>();
      const session = yield* createHostProxyRunLandoSession({
        app,
        mountInfo: hostProxyMountInfoFromPlan(input.plan),
        allowlist: HOST_PROXY_RUNLANDO_ALLOWLIST,
        callerService: "lando",
        executor: (request) => runOpenForHostProxy(input.plan, request).pipe(Effect.provide(runtimeContext)),
        paths: rootOverridesFromWorkerInput(input.paths),
        shimArtifactPath: input.shimArtifactPath,
        ...(input.shimTarget === undefined ? {} : { shimTarget: input.shimTarget }),
        ...(input.hostGatewayName === undefined ? {} : { hostGatewayName: input.hostGatewayName }),
      });
      yield* Effect.sync(() => {
        stdout.write(
          `${JSON.stringify({
            _tag: "ready",
            appId: session.appId,
            sessionId: session.sessionId,
            token: session.token,
            controlToken: session.controlToken,
            ...(session.socketPath === undefined ? {} : { socketPath: session.socketPath }),
            ...(session.url === undefined ? {} : { url: session.url }),
            ...(session.containerUrl === undefined ? {} : { containerUrl: session.containerUrl }),
            shimPath: session.shimPath,
            transport: session.transport,
          })}\n`,
        );
        detachHostProxyWorkerStdio();
      });
      yield* Effect.async<void>((resume) => {
        const shutdown = () => {
          void session.close().finally(() => resume(Effect.void));
        };
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
        void session.closed.then(() => resume(Effect.void));
      });
    }).pipe(Effect.provide(runtime)),
  );
};

const detachHostProxyWorkerStdio = (): void => {
  const sink: typeof stdout.write = ((
    _chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    if (typeof encodingOrCallback === "function") encodingOrCallback(null);
    else if (typeof callback === "function") callback(null);
    return true;
  }) as typeof stdout.write;
  try {
    stdout.write = sink;
    process.stderr.write = sink;
  } catch {
    return;
  }
};
