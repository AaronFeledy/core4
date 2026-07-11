import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stdout } from "node:process";
import { Effect, Schema } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import { AppPlan, type AppRef } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import type { RedactionService } from "../../redaction/service.ts";
import { cliRuntimeOptions } from "../../runtime/cli-options.ts";
import { makeLandoRuntime } from "../../runtime/layer.ts";
import { HOST_PROXY_RUNLANDO_ALLOWLIST } from "./api.ts";
import { runOpenForHostProxy } from "./dispatch.ts";
import { createHostProxyRunLandoSession, hostProxyRunLandoStateDir } from "./transport.ts";
import {
  type HostProxyWorkerSpawner,
  defaultSpawnWorker,
  hostProxyWorkerArgv,
  stdinText,
} from "./worker-process.ts";

export { HOST_PROXY_WORKER_COMMAND, hostProxyWorkerArgv } from "./worker-process.ts";

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
});
type WorkerInput = typeof WorkerInput.Type;

const WorkerOwnership = Schema.Struct({
  appId: Schema.String,
  pid: Schema.Number,
  argv: Schema.Array(Schema.String),
  argvFingerprint: Schema.String,
  socketPath: Schema.String,
  shimPath: Schema.String,
});
type WorkerOwnership = typeof WorkerOwnership.Type;

export interface DetachedHostProxyWorkerOptions {
  readonly app: AppRef;
  readonly plan: AppPlan;
  readonly paths?: RootOverrides;
  readonly shimArtifactPath: string;
  readonly spawnWorker?: HostProxyWorkerSpawner;
}

export interface TerminateHostProxyWorkerOptions {
  readonly paths?: RootOverrides;
  readonly readProcessArgv?: (pid: number) => Promise<ReadonlyArray<string>>;
  readonly terminateProcess?: (pid: number) => Promise<void>;
}

const fingerprintArgv = (argv: ReadonlyArray<string>): string =>
  createHash("sha256").update(JSON.stringify(argv)).digest("hex");

export const workerOwnershipPath = (app: AppRef, paths?: RootOverrides): string =>
  resolve(hostProxyRunLandoStateDir(app, paths), "worker.json");

const defaultReadProcessArgv = async (pid: number): Promise<ReadonlyArray<string>> => {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter((part) => part.length > 0);
  } catch {
    return [];
  }
};

const defaultTerminateProcess = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
};

const rootOverridesFromWorkerInput = (paths: WorkerInput["paths"]): RootOverrides => ({
  ...(paths.userConfRoot === undefined ? {} : { userConfRoot: paths.userConfRoot }),
  ...(paths.userCacheRoot === undefined ? {} : { userCacheRoot: paths.userCacheRoot }),
  ...(paths.userDataRoot === undefined ? {} : { userDataRoot: paths.userDataRoot }),
  ...(paths.systemPluginRoot === undefined ? {} : { systemPluginRoot: paths.systemPluginRoot }),
  ...(paths.platform === undefined ? {} : { platform: paths.platform }),
});

const readOwnership = async (app: AppRef, paths?: RootOverrides): Promise<WorkerOwnership | undefined> => {
  try {
    return Schema.decodeUnknownSync(WorkerOwnership)(
      JSON.parse(await readFile(workerOwnershipPath(app, paths), "utf8")),
    );
  } catch {
    return undefined;
  }
};

const readOwnershipFile = async (path: string): Promise<WorkerOwnership | undefined> => {
  try {
    return Schema.decodeUnknownSync(WorkerOwnership)(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return undefined;
  }
};

const terminateVerifiedOwnership = async (
  ownership: WorkerOwnership,
  options: TerminateHostProxyWorkerOptions,
): Promise<void> => {
  const actualArgv = await (options.readProcessArgv ?? defaultReadProcessArgv)(ownership.pid);
  if (actualArgv.length === 0 || fingerprintArgv(actualArgv) !== ownership.argvFingerprint) return;
  await (options.terminateProcess ?? defaultTerminateProcess)(ownership.pid);
};

const writeOwnership = async (
  app: AppRef,
  paths: RootOverrides | undefined,
  ownership: WorkerOwnership,
): Promise<void> => {
  const path = workerOwnershipPath(app, paths);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600 });
};

export const startDetachedHostProxyWorker = (options: DetachedHostProxyWorkerOptions) =>
  Effect.tryPromise({
    try: async () => {
      const spawnWorker = options.spawnWorker ?? defaultSpawnWorker;
      const argv = hostProxyWorkerArgv();
      const worker = spawnWorker({ argv });
      try {
        const encodedPlan = Schema.encodeUnknownSync(AppPlan)(options.plan);
        const paths = makeLandoPaths(options.paths).roots;
        await worker.writeStdin(
          `${JSON.stringify({ app: options.app, plan: encodedPlan, paths, shimArtifactPath: options.shimArtifactPath })}\n`,
        );
        const ready = await worker.readReady();
        const ownership: WorkerOwnership = {
          appId: options.app.id,
          pid: worker.pid,
          argv: [...worker.argv],
          argvFingerprint: fingerprintArgv(worker.argv),
          socketPath: ready.socketPath,
          shimPath: ready.shimPath,
        };
        await writeOwnership(options.app, options.paths, ownership);
        return {
          appId: ready.appId,
          sessionId: ready.sessionId,
          token: ready.token,
          socketPath: ready.socketPath,
          shimPath: ready.shimPath,
          close: () => worker.terminate(),
        };
      } catch (cause) {
        await worker.terminate();
        throw cause;
      }
    },
    catch: (cause) =>
      new HostProxyTransportUnavailableError({
        message: cause instanceof Error ? cause.message : String(cause),
        socketPath: workerOwnershipPath(options.app, options.paths),
        remediation: "Inspect the detached host-proxy worker startup failure.",
      }),
  });

export const terminateOwnedHostProxyWorker = (app: AppRef, options: TerminateHostProxyWorkerOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      const ownership = await readOwnership(app, options.paths);
      if (ownership === undefined) return;
      await terminateVerifiedOwnership(ownership, options);
    },
    catch: () => undefined,
  }).pipe(Effect.asVoid);

export const terminateOwnedHostProxyWorkersInRoot = (
  userDataRoot: string,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const root = makeLandoPaths({ userDataRoot }).hostProxyRunRoot;
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const ownership = await readOwnershipFile(resolve(root, entry.name, "worker.json"));
        if (ownership === undefined || ownership.appId !== entry.name) continue;
        await terminateVerifiedOwnership(ownership, options);
      }
    },
    catch: () => undefined,
  }).pipe(Effect.asVoid);

export const runHostProxyWorkerProcess = async (): Promise<void> => {
  const input = Schema.decodeUnknownSync(WorkerInput)(JSON.parse(await stdinText()));
  const app = { kind: input.app.kind, id: input.app.id, root: input.app.root } as AppRef;
  const runtime = makeLandoRuntime(cliRuntimeOptions({ bootstrap: "app", plugins: { policy: "discovery" } }));
  const session = await Effect.runPromise(
    Effect.gen(function* () {
      const runtimeContext = yield* Effect.context<ShellRunner | EventService | RedactionService>();
      return yield* createHostProxyRunLandoSession({
        app,
        mountInfo: { containerRoot: "/app", hostRoot: String(input.plan.root) },
        allowlist: HOST_PROXY_RUNLANDO_ALLOWLIST,
        callerService: "lando",
        executor: (request) => runOpenForHostProxy(input.plan, request).pipe(Effect.provide(runtimeContext)),
        paths: rootOverridesFromWorkerInput(input.paths),
        shimArtifactPath: input.shimArtifactPath,
      });
    }).pipe(Effect.provide(runtime)),
  );
  stdout.write(
    `${JSON.stringify({
      _tag: "ready",
      appId: session.appId,
      sessionId: session.sessionId,
      token: session.token,
      socketPath: session.socketPath,
      shimPath: session.shimPath,
    })}\n`,
  );
  await new Promise<void>((resolveShutdown) => {
    const shutdown = () => {
      void session.close().finally(resolveShutdown);
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  });
};

export const removeHostProxyWorkerState = (app: AppRef, paths?: RootOverrides): Effect.Effect<void, never> =>
  terminateOwnedHostProxyWorker(app, paths === undefined ? {} : { paths }).pipe(
    Effect.zipRight(
      Effect.promise(() => rm(dirname(workerOwnershipPath(app, paths)), { recursive: true, force: true })),
    ),
    Effect.catchAll(() => Effect.void),
  );
