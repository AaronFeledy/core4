import { Effect, type Runtime, Stream } from "effect";

import type {
  App,
  AppRemoteMutationOptions,
  AppRemoteRemoveOptions,
  AppRemoteSetupOptions,
  AppRemoteTestOptions,
  DestroyAppOptions,
  ExecAppOptions,
  InfoAppOptions,
  LandoRuntimeServices,
  LogsAppOptions,
  PullAppOptions,
  PushAppOptions,
  RebuildAppOptions,
  RestartAppOptions,
  StartAppOptions,
  StopAppOptions,
  ToolingOptions,
} from "@lando/sdk/app";
import type { ServiceName } from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";
import { EventService } from "@lando/sdk/services";

import type { ResolvedAppTarget } from "../cli/app-resolution.ts";
import type { LogsAppLine } from "../cli/commands/logs.ts";
import type { AppLifecycle } from "./lifecycle.ts";
import type { AppOperations } from "./operations.ts";

const toLogChunk = (line: LogsAppLine): LogChunk => ({
  service: line.service as ServiceName,
  stream: line.stream,
  line: line.line,
  ...(line.timestamp === undefined ? {} : { timestamp: new Date(line.timestamp) }),
});

/**
 * Builds the opaque/branded `App` handle returned by `resolveApp`/`runtime.app`.
 * The command-operation seam (`ops`) is passed in (loaded lazily by the caller)
 * so the default `@lando/core` import graph stays OCLIF/TUI-free; each method
 * binds the captured runtime so one-shot methods require no services.
 */
export const makeAppHandle = (
  target: ResolvedAppTarget,
  runtime: Runtime.Runtime<LandoRuntimeServices>,
  ops: AppOperations,
  lifecycle: AppLifecycle,
): App => {
  const { plan, app: ref, root } = target;
  const handle = {
    id: plan.id,
    ref,
    root,
    plan: Effect.succeed(plan),
    start: (options?: StartAppOptions) =>
      lifecycle.serialize(
        Effect.gen(function* () {
          const current = yield* lifecycle.current;
          if (current !== undefined && options?.detached !== true && options?.reconcile !== true) {
            return yield* ops
              .startApp(options, target, {
                scope: current,
                onScopeClosedByStartApp: lifecycle.forgetIfCurrent(current),
              })
              .pipe(Effect.provide(runtime));
          }
          yield* lifecycle.closeCurrent;
          if (options?.detached === true) {
            return yield* ops.startApp(options, target).pipe(Effect.provide(runtime));
          }
          const scope = yield* lifecycle.installFresh;
          return yield* ops
            .startApp(options, target, {
              scope,
              onScopeClosedByStartApp: lifecycle.forgetIfCurrent(scope),
            })
            .pipe(
              Effect.provide(runtime),
              Effect.onError(() => lifecycle.discardIfCurrent(scope)),
            );
        }),
      ),
    stop: (options?: StopAppOptions) =>
      lifecycle.serialize(
        ops.stopApp(options, target).pipe(Effect.provide(runtime), Effect.ensuring(lifecycle.closeCurrent)),
      ),
    restart: (options?: RestartAppOptions) =>
      lifecycle.serialize(
        Effect.gen(function* () {
          yield* ops.stopApp({}, target).pipe(Effect.provide(runtime));
          yield* lifecycle.closeCurrent;
          const scope = yield* lifecycle.installFresh;
          const start = yield* ops
            .startApp(
              {
                reconcile: options?.reconcile ?? false,
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
              },
              target,
              {
                scope,
                onScopeClosedByStartApp: lifecycle.forgetIfCurrent(scope),
              },
            )
            .pipe(
              Effect.provide(runtime),
              Effect.onError(() => lifecycle.discardIfCurrent(scope)),
            );
          return { app: start.app, servicesStarted: start.servicesStarted };
        }),
      ),
    rebuild: (options?: RebuildAppOptions) =>
      lifecycle.serialize(
        Effect.gen(function* () {
          yield* ops.stopApp({}, target).pipe(Effect.provide(runtime));
          yield* lifecycle.closeCurrent;
          const scope = yield* lifecycle.installFresh;
          const start = yield* ops
            .startApp(
              {
                reconcile: true,
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
              },
              target,
              {
                scope,
                onScopeClosedByStartApp: lifecycle.forgetIfCurrent(scope),
              },
            )
            .pipe(
              Effect.provide(runtime),
              Effect.onError(() => lifecycle.discardIfCurrent(scope)),
            );
          return {
            app: start.app,
            servicesRebuilt: start.servicesStarted.map((service) => service.name),
            servicesStarted: start.servicesStarted,
          };
        }),
      ),
    destroy: (options?: DestroyAppOptions) =>
      lifecycle.serialize(
        ops
          .destroyApp(options, target)
          .pipe(Effect.provide(runtime), Effect.ensuring(lifecycle.closeCurrent)),
      ),
    info: (options?: InfoAppOptions) => ops.infoApp(options, target).pipe(Effect.provide(runtime)),
    exec: (options: ExecAppOptions) => ops.execApp(options, target).pipe(Effect.provide(runtime)),
    tooling: (id: string, options?: ToolingOptions) =>
      ops.runTooling({ name: id, cwd: root, ...options }, target).pipe(Effect.provide(runtime)),
    logs: (options?: LogsAppOptions) =>
      Stream.unwrap(
        ops.logsApp(options, target).pipe(
          Effect.map((result) => Stream.fromIterable(result.lines.map(toLogChunk))),
          Effect.provide(runtime),
        ),
      ),
    pull: (options?: PullAppOptions) => ops.appPull(options, target).pipe(Effect.provide(runtime)),
    push: (options?: PushAppOptions) => ops.appPush(options, target).pipe(Effect.provide(runtime)),
    remote: {
      list: () => ops.appRemoteList({ cwd: root }).pipe(Effect.provide(runtime)),
      add: (options: AppRemoteMutationOptions) =>
        ops.appRemoteAdd({ cwd: root, ...options }).pipe(Effect.provide(runtime)),
      remove: (options: AppRemoteRemoveOptions) =>
        ops.appRemoteRemove({ cwd: root, ...options }).pipe(Effect.provide(runtime)),
      test: (options?: AppRemoteTestOptions) =>
        ops.appRemoteTest({ cwd: root, ...options }).pipe(Effect.provide(runtime)),
      setup: (options?: AppRemoteSetupOptions) =>
        ops.appRemoteSetup({ cwd: root, ...options }).pipe(Effect.provide(runtime)),
      env: {
        list: (options?: AppRemoteTestOptions) =>
          ops.appRemoteEnvList({ cwd: root, ...options }).pipe(Effect.provide(runtime)),
      },
    },
    config: {
      lint: (options?: { readonly cwd?: string }) =>
        ops.appConfigLint({ ...options, cwd: options?.cwd ?? root }),
    },
    events: {
      subscribe: (name?: string) =>
        Stream.unwrap(
          EventService.pipe(
            Effect.map((events) => events.subscribe(name ?? "*")),
            Effect.provide(runtime),
          ),
        ),
    },
  };
  return handle as unknown as App;
};
