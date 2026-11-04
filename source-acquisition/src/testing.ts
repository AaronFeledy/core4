import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { ProcessExecError } from "@lando/sdk/errors";
import type { ProcessResult, ProcessRunner, ProcessSpawnOptions, StateStoreShape } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";
import { Effect, Stream } from "effect";
import type { SourceAcquisitionError } from "./errors.ts";
import { makeSourceStore } from "./index.ts";
export { processIsAlive } from "./storage.ts";
import type {
  ArchiveTransport,
  GitTransport,
  NpmRegistryTransport,
  SourceSession,
  SourceStore,
  SourceTransports,
} from "./types.ts";

export interface TestSourceStoreOptions {
  readonly root?: string;
  readonly stateStore?: StateStoreShape;
  readonly transports?: Partial<SourceTransports>;
  readonly npmRegistry?: NpmRegistryTransport;
  readonly archive?: ArchiveTransport;
  readonly git?: GitTransport;
}
export interface TestSourceStore {
  readonly store: SourceStore;
  readonly root: string;
  readonly stateStore: StateStoreShape;
  readonly ownsRoot: boolean;
}
export const makeTestProcessRunner = (): ProcessRunner["Service"] => {
  const run = (options: ProcessSpawnOptions): Effect.Effect<ProcessResult, ProcessExecError> =>
    Effect.tryPromise({
      try: async (signal) => {
        const proc = Bun.spawn({
          cmd: [options.cmd, ...options.args],
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          env: options.replaceEnv ? { ...options.env } : { ...process.env, ...options.env },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "pipe",
          signal,
        });
        if (options.stdin !== undefined) proc.stdin.write(options.stdin);
        await proc.stdin.end();
        const [exitCode, stdout, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      catch: (cause) =>
        new ProcessExecError({
          message: cause instanceof Error ? cause.message : String(cause),
          cmd: options.cmd,
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          remediation: "Ensure the host command is installed and reachable from PATH.",
          cause,
        }),
    });
  return {
    run,
    stream: (options) =>
      Stream.unwrap(
        run(options).pipe(
          Effect.map((result) =>
            Stream.fromIterable([
              { kind: "stdout", chunk: new TextEncoder().encode(result.stdout) } as const,
              { kind: "stderr", chunk: new TextEncoder().encode(result.stderr) } as const,
            ]),
          ),
        ),
      ),
    streamWithExit: (options) =>
      Stream.unwrap(
        run(options).pipe(
          Effect.map((result) =>
            Stream.fromIterable([
              { kind: "stdout", chunk: new TextEncoder().encode(result.stdout) } as const,
              { kind: "stderr", chunk: new TextEncoder().encode(result.stderr) } as const,
              { exitCode: result.exitCode },
            ]),
          ),
        ),
      ),
  };
};
export const makeTestSourceStore = async (options: TestSourceStoreOptions = {}): Promise<TestSourceStore> => {
  const ownsRoot = options.root === undefined;
  const root = options.root ?? join(await mkdtemp(join(tmpdir(), "lando-source-store-")), "sources");
  await mkdir(root, { recursive: true });
  const cacheRoot = dirname(root);
  const stateStore =
    options.stateStore ??
    makeStateStore({
      roots: makeLandoPaths({
        userCacheRoot: cacheRoot,
        userDataRoot: join(cacheRoot, "data"),
        userConfRoot: join(cacheRoot, "conf"),
        systemPluginRoot: join(cacheRoot, "system"),
      }).roots,
      privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
    });
  const transports: SourceTransports = {
    ...options.transports,
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.npmRegistry === undefined ? {} : { npmRegistry: options.npmRegistry }),
    ...(options.archive === undefined ? {} : { archive: options.archive }),
  };
  return { root, stateStore, ownsRoot, store: makeSourceStore({ root, stateStore, transports }) };
};
export const disposeTestSourceStore = async (fixture: TestSourceStore): Promise<void> => {
  if (fixture.ownsRoot) await rm(dirname(fixture.root), { recursive: true, force: true });
};
export const withTestSession = <A, E, R>(
  store: SourceStore,
  body: (session: SourceSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SourceAcquisitionError, R> => Effect.scoped(store.session.pipe(Effect.flatMap(body)));
export const withTestSources = async <A, E>(
  options: TestSourceStoreOptions,
  body: (input: {
    readonly store: SourceStore;
    readonly root: string;
    readonly stateStore: StateStoreShape;
    readonly session: SourceSession;
  }) => Effect.Effect<A, E>,
): Promise<A> => {
  const fixture = await makeTestSourceStore(options);
  try {
    return await Effect.runPromise(
      withTestSession(fixture.store, (session) => body({ ...fixture, session })),
    );
  } finally {
    await disposeTestSourceStore(fixture);
  }
};
export type {
  ArchiveTransport,
  GitTransport,
  NpmRegistryTransport,
  SourceSession,
  SourceStore,
  SourceTransports,
};
