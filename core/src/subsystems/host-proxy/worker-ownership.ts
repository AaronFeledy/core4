import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Effect, Schema } from "effect";

import type { AppRef } from "@lando/sdk/schema";

import type { RootOverrides } from "../../config/paths.ts";
import { makeLandoPaths } from "../../config/paths.ts";
import { hostProxyRunLandoStateDir } from "./transport.ts";
import { HOST_PROXY_WORKER_COMMAND } from "./worker-process.ts";

const WorkerOwnership = Schema.Struct({
  appId: Schema.String,
  pid: Schema.Number,
  argv: Schema.Array(Schema.String),
  argvFingerprint: Schema.String,
  socketPath: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  containerUrl: Schema.optional(Schema.String),
  shimPath: Schema.String,
});
type WorkerOwnership = typeof WorkerOwnership.Type;

export interface TerminateHostProxyWorkerOptions {
  readonly paths?: RootOverrides;
  readonly readProcessArgv?: (pid: number) => Promise<ReadonlyArray<string>>;
  readonly readProcessCommand?: (pid: number) => Promise<string>;
  readonly terminateProcess?: (pid: number) => Promise<void>;
  readonly platform?: NodeJS.Platform;
}

type TerminateOwnershipResult = "terminated" | "absent" | "unverified";

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

const defaultReadProcessCommand = async (pid: number): Promise<string> => {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-ww", "-o", "command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
  return exitCode === 0 ? stdout.trim() : "";
};

const commandMatchesOwnership = (command: string, ownership: WorkerOwnership): boolean => {
  const argv = command.split(/\s+/u).filter((part) => part.length > 0);
  const appMarkerIndex = argv.indexOf("--app-id");
  return (
    argv.includes(HOST_PROXY_WORKER_COMMAND) &&
    appMarkerIndex >= 0 &&
    argv[appMarkerIndex + 1] === ownership.appId
  );
};

const defaultTerminateProcess = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
};

export const readOwnership = async (
  app: AppRef,
  paths?: RootOverrides,
): Promise<WorkerOwnership | undefined> => {
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

export const terminateVerifiedOwnership = async (
  ownership: WorkerOwnership,
  options: TerminateHostProxyWorkerOptions,
): Promise<TerminateOwnershipResult> => {
  const platform = options.platform ?? process.platform;
  if (options.readProcessArgv !== undefined || platform === "linux") {
    const actualArgv = await (options.readProcessArgv ?? defaultReadProcessArgv)(ownership.pid);
    if (actualArgv.length === 0) return "absent";
    if (fingerprintArgv(actualArgv) !== ownership.argvFingerprint) return "unverified";
  } else {
    const command = await (options.readProcessCommand ?? defaultReadProcessCommand)(ownership.pid);
    if (command.length === 0) return "absent";
    if (!commandMatchesOwnership(command, ownership)) return "unverified";
  }
  await (options.terminateProcess ?? defaultTerminateProcess)(ownership.pid);
  return "terminated";
};

export const writeOwnership = async (
  app: AppRef,
  paths: RootOverrides | undefined,
  ownership: Omit<WorkerOwnership, "argvFingerprint">,
): Promise<void> => {
  const path = workerOwnershipPath(app, paths);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify({ ...ownership, argvFingerprint: fingerprintArgv(ownership.argv) }, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
};

export const terminateOwnedHostProxyWorker = (app: AppRef, options: TerminateHostProxyWorkerOptions = {}) =>
  Effect.tryPromise({
    try: async () => {
      const ownership = await readOwnership(app, options.paths);
      if (ownership === undefined) return "absent";
      return await terminateVerifiedOwnership(ownership, options);
    },
    catch: () => "unverified" as const,
  });

export const terminateOwnedHostProxyWorkersInRoot = (
  userDataRoot: string,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
) =>
  Effect.tryPromise({
    try: async () => {
      const root = makeLandoPaths({ userDataRoot }).hostProxyRunRoot;
      const paths = makeLandoPaths({ userDataRoot });
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const appRunDir = resolve(root, entry.name);
        const ownership = await readOwnershipFile(resolve(appRunDir, "worker.json"));
        if (ownership === undefined || resolve(paths.hostProxyRunDir(ownership.appId)) !== appRunDir)
          continue;
        if ((await terminateVerifiedOwnership(ownership, options)) !== "unverified")
          await rm(appRunDir, { recursive: true, force: true });
      }
    },
    catch: () => undefined,
  }).pipe(Effect.asVoid);

export const removeOwnedHostProxyWorkerState = (
  app: AppRef,
  paths?: RootOverrides,
  options: Omit<TerminateHostProxyWorkerOptions, "paths"> = {},
): Effect.Effect<void, never> =>
  terminateOwnedHostProxyWorker(app, { ...options, ...(paths === undefined ? {} : { paths }) }).pipe(
    Effect.flatMap((result) =>
      result !== "unverified"
        ? Effect.promise(() => rm(dirname(workerOwnershipPath(app, paths)), { recursive: true, force: true }))
        : Effect.void,
    ),
    Effect.catchAll(() => Effect.void),
  );
