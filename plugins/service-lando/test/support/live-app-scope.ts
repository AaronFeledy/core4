import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { serviceContainerName } from "@lando/container-runtime/plan";
import { bringDown, bringUp, exec, makePodmanApiClient } from "@lando/provider-lando";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { ExecResult } from "@lando/sdk/services";
import { Duration, Effect, type Scope } from "effect";

/**
 * Podman API client handle shared by every lifecycle call for one live app.
 */
export type LiveProviderApi = ReturnType<typeof makePodmanApiClient>;

export interface BringDownOptions {
  readonly volumes?: boolean | undefined;
}

/**
 * The provider calls a live test needs, narrowed to what the scope owns so a
 * unit test can substitute fakes without a container runtime.
 */
export interface LiveAppLifecycle {
  readonly clearPreviousRun: (plan: AppPlan, api: LiveProviderApi) => Effect.Effect<void, unknown>;
  readonly bringUp: (plan: AppPlan, api: LiveProviderApi) => Effect.Effect<void, unknown>;
  readonly bringDown: (
    plan: AppPlan,
    api: LiveProviderApi,
    options: BringDownOptions,
  ) => Effect.Effect<void, unknown>;
  readonly exec: (
    plan: AppPlan,
    api: LiveProviderApi,
    service: ServiceName,
    command: ReadonlyArray<string>,
  ) => Effect.Effect<ExecResult, unknown>;
}

export interface LiveApp {
  readonly plan: AppPlan;
  readonly api: LiveProviderApi;
  readonly exec: (service: string, command: ReadonlyArray<string>) => Effect.Effect<ExecResult, unknown>;
}

export const defaultLiveAppLifecycle: LiveAppLifecycle = {
  clearPreviousRun: (plan, api) =>
    Effect.gen(function* () {
      const request = api.request;
      if (request === undefined)
        return yield* Effect.fail(new Error("Live app cleanup requires a provider API request client."));
      const targets = [
        ...Object.values(plan.services).map((service) => ({
          // The engine API takes the query in the path; a running leftover needs force.
          path: `/containers/${encodeURIComponent(serviceContainerName(plan, service.name))}?force=true` as const,
        })),
        ...plan.stores.map((store) => ({ path: `/volumes/${encodeURIComponent(store.name)}` as const })),
      ];
      for (const target of targets) {
        const response = yield* request({ method: "DELETE", ...target });
        if (response.status !== 200 && response.status !== 204 && response.status !== 404) {
          return yield* Effect.fail(
            new Error(
              `Unable to clear previous live app run: DELETE ${target.path} returned HTTP ${response.status}.`,
            ),
          );
        }
      }
    }),
  bringUp: (plan, api) => Effect.asVoid(bringUp(plan, { api })),
  bringDown: (plan, api, options) =>
    Effect.asVoid(
      bringDown(plan, {
        api,
        ...(options.volumes === undefined ? {} : { volumes: options.volumes }),
      }),
    ),
  exec: (plan, api, service, command) =>
    exec(plan, { app: plan.id, service }, { command: [...command] }, { api }),
};

/**
 * A temporary app root owned by the scope. Bind-mount sources have to exist on
 * disk before the provider starts a container, and they have to outlive it, so
 * the directory is released only after everything acquired later is gone.
 */
export const acquireTempAppRoot = (prefix: string): Effect.Effect<string, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

/**
 * Writes a config fixture under the app root. The mode is explicit because a
 * daemon reads these through a read-only bind as its own non-root account, and
 * MySQL additionally ignores a world-writable config file.
 */
export const writeFixture = (
  appRoot: string,
  relativePath: string,
  contents: string,
): Effect.Effect<string> =>
  Effect.promise(async () => {
    const target = join(appRoot, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    await chmod(target, 0o644);
    return target;
  });

/**
 * Starts an app and hands back an exec handle. The release step runs on every
 * exit path, including a failing assertion, and takes the named volumes with
 * it: a leftover data volume both blocks the next run that reuses the store and
 * makes a database skip initialization, which would let a later run pass on
 * stale state.
 *
 * A teardown failure is a defect rather than a swallowed warning, so a live
 * test can never leave provider resources behind quietly.
 */
export const acquireLiveApp = (args: {
  readonly plan: AppPlan;
  readonly socketPath: string;
  readonly lifecycle?: LiveAppLifecycle;
}): Effect.Effect<LiveApp, unknown, Scope.Scope> => {
  const lifecycle = args.lifecycle ?? defaultLiveAppLifecycle;
  const api = makePodmanApiClient(args.socketPath);
  const app: LiveApp = {
    plan: args.plan,
    api,
    exec: (service, command) => lifecycle.exec(args.plan, api, ServiceName.make(service), command),
  };
  return Effect.acquireRelease(
    Effect.as(
      Effect.zipRight(lifecycle.clearPreviousRun(args.plan, api), lifecycle.bringUp(args.plan, api)),
      app,
    ),
    () => Effect.orDie(lifecycle.bringDown(args.plan, api, { volumes: true })),
  );
};

/**
 * Polls one command inside a running service until `accept` holds. A daemon
 * that is still initializing answers with an error or an empty value first, so
 * the loop tolerates failures until the deadline and then reports the last
 * thing the daemon actually said.
 */
export const execUntil = (args: {
  readonly app: LiveApp;
  readonly service: string;
  readonly command: ReadonlyArray<string>;
  readonly accept: (result: ExecResult) => boolean;
  readonly timeoutMs: number;
  readonly intervalMs?: number;
}): Effect.Effect<ExecResult, Error> =>
  Effect.gen(function* () {
    const interval = Duration.millis(args.intervalMs ?? 2_000);
    const deadline = Date.now() + args.timeoutMs;
    let last = "<never ran>";
    while (Date.now() < deadline) {
      const attempt = yield* Effect.either(args.app.exec(args.service, args.command));
      if (attempt._tag === "Right") {
        if (args.accept(attempt.right)) return attempt.right;
        last = `exit ${attempt.right.exitCode} stdout=${JSON.stringify(attempt.right.stdout)} stderr=${JSON.stringify(attempt.right.stderr)}`;
      } else {
        last = String(attempt.left);
      }
      yield* Effect.sleep(interval);
    }
    return yield* Effect.fail(
      new Error(
        `Service ${args.service} never satisfied \`${args.command.join(" ")}\` within ${args.timeoutMs}ms. Last observation: ${last}`,
      ),
    );
  });
