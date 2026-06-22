import { Effect, type Runtime, Stream } from "effect";

import type {
  App,
  DestroyAppOptions,
  ExecAppOptions,
  InfoAppOptions,
  LandoRuntimeServices,
  LogsAppOptions,
  RebuildAppOptions,
  RestartAppOptions,
  StartAppOptions,
  StopAppOptions,
  ToolingOptions,
} from "@lando/sdk/app";
import type { AppPlan, AppRef, ServiceName } from "@lando/sdk/schema";
import type { LogChunk } from "@lando/sdk/services";
import { EventService } from "@lando/sdk/services";

import type { LogsAppLine } from "../cli/commands/logs.ts";
import type { AppOperations } from "./operations.ts";

const appRef = (plan: AppPlan): AppRef => ({ kind: "user", id: plan.id, root: plan.root });

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
  plan: AppPlan,
  runtime: Runtime.Runtime<LandoRuntimeServices>,
  ops: AppOperations,
): App => {
  const ref = appRef(plan);
  const handle = {
    id: plan.id,
    ref,
    root: plan.root,
    plan: Effect.succeed(plan),
    start: (options?: StartAppOptions) => ops.startApp(options).pipe(Effect.provide(runtime)),
    stop: (options?: StopAppOptions) => ops.stopApp(options).pipe(Effect.provide(runtime)),
    restart: (options?: RestartAppOptions) => ops.restartApp(options).pipe(Effect.provide(runtime)),
    rebuild: (options?: RebuildAppOptions) => ops.rebuildApp(options).pipe(Effect.provide(runtime)),
    destroy: (options?: DestroyAppOptions) => ops.destroyApp(options).pipe(Effect.provide(runtime)),
    info: (options?: InfoAppOptions) => ops.infoApp(options).pipe(Effect.provide(runtime)),
    exec: (options: ExecAppOptions) => ops.execApp(options).pipe(Effect.provide(runtime)),
    tooling: (id: string, options?: ToolingOptions) =>
      ops.runTooling({ name: id, ...options }).pipe(Effect.provide(runtime)),
    logs: (options?: LogsAppOptions) =>
      Stream.unwrap(
        ops.logsApp(options).pipe(
          Effect.map((result) => Stream.fromIterable(result.lines.map(toLogChunk))),
          Effect.provide(runtime),
        ),
      ),
    config: {
      lint: (options?: { readonly cwd?: string }) => ops.appConfigLint(options),
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
