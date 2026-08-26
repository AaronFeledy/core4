import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Effect } from "effect";

import {
  HOST_PROXY_SHIM_ARTIFACT_ENV,
  type HostProxyShimTarget,
  defaultHostProxyShimArtifactPath,
} from "@lando/engine/subsystems/host-proxy/transport-shim";
import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";

export interface HostProxyShimSpawnResult {
  readonly exitCode: number;
  readonly stderr: string;
}

export type HostProxyShimSpawner = (
  argv: readonly string[],
  cwd: string,
) => Promise<HostProxyShimSpawnResult>;

export interface PrepareHostProxyShimArtifactInput {
  readonly target: HostProxyShimTarget;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly execPath?: string;
  readonly distRoot?: string;
  readonly sourcePath?: string;
  readonly spawn?: HostProxyShimSpawner;
}

type PrepareMode =
  | { readonly _tag: "override"; readonly path: string }
  | { readonly _tag: "compiled"; readonly path: string }
  | { readonly _tag: "source"; readonly path: string };

const CORE_PACKAGE_ROOT = new URL("../../../", import.meta.url).pathname;
const DEFAULT_SOURCE_PATH = new URL("./shim-bin.ts", import.meta.url).pathname;
const inflight = new Map<string, Promise<string>>();

const assertNever = (value: never): never => {
  throw new Error(`Unexpected prepare mode: ${JSON.stringify(value)}`);
};

const isNodeError = (cause: unknown): cause is NodeJS.ErrnoException =>
  cause instanceof Error && "code" in cause;

const unavailable = (socketPath: string, cause: unknown): HostProxyTransportUnavailableError =>
  new HostProxyTransportUnavailableError({
    message: cause instanceof Error ? cause.message : String(cause),
    socketPath,
    remediation:
      "Run `bun run --filter='@lando/core' build:host-proxy-shim` before starting apps that use host-proxy runLando.",
  });

const unlinkIfPresent = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return;
    throw cause;
  }
};

const statIfPresent = async (path: string): Promise<{ readonly mtimeMs: number } | undefined> => {
  try {
    return await stat(path);
  } catch (cause) {
    if (isNodeError(cause) && cause.code === "ENOENT") return undefined;
    throw cause;
  }
};

const defaultSpawn: HostProxyShimSpawner = async (argv, cwd) => {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  const [, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr };
};

const resolveMode = (input: PrepareHostProxyShimArtifactInput): PrepareMode => {
  const env = input.env ?? process.env;
  const configured = env[HOST_PROXY_SHIM_ARTIFACT_ENV];
  if (configured !== undefined && configured.length > 0) {
    return { _tag: "override", path: configured };
  }
  const execPath = input.execPath ?? process.execPath;
  const path = defaultHostProxyShimArtifactPath({
    env,
    execPath,
    target: input.target,
    ...(input.distRoot === undefined ? {} : { distRoot: input.distRoot }),
  });
  const execName = basename(execPath).toLowerCase();
  if (execName === "bun" || execName === "bun.exe") return { _tag: "source", path };
  return { _tag: "compiled", path };
};

const compileArtifact = async (
  input: PrepareHostProxyShimArtifactInput,
  artifactPath: string,
): Promise<string> => {
  const execPath = input.execPath ?? process.execPath;
  const spawn = input.spawn ?? defaultSpawn;
  const tempPath = `${artifactPath}.tmp.${process.pid}`;
  const argv = [
    execPath,
    "build",
    "./src/cli/host-proxy/shim-bin.ts",
    "--compile",
    `--target=bun-linux-${input.target.arch}`,
    "--outfile",
    tempPath,
  ];
  await mkdir(dirname(artifactPath), { recursive: true });
  try {
    const result = await spawn(argv, CORE_PACKAGE_ROOT);
    if (result.exitCode !== 0) {
      throw unavailable(artifactPath, result.stderr);
    }
    await rename(tempPath, artifactPath);
    await chmod(artifactPath, 0o755);
    return artifactPath;
  } catch (cause) {
    await unlinkIfPresent(tempPath);
    if (cause instanceof HostProxyTransportUnavailableError) throw cause;
    throw unavailable(artifactPath, cause);
  }
};

const prepareSource = async (
  input: PrepareHostProxyShimArtifactInput,
  artifactPath: string,
): Promise<string> => {
  const sourcePath = input.sourcePath ?? DEFAULT_SOURCE_PATH;
  const artifact = await statIfPresent(artifactPath);
  const source = await statIfPresent(sourcePath);
  if (artifact !== undefined && source !== undefined && artifact.mtimeMs >= source.mtimeMs) {
    return artifactPath;
  }
  return compileArtifact(input, artifactPath);
};

const runPrepare = async (input: PrepareHostProxyShimArtifactInput): Promise<string> => {
  const mode = resolveMode(input);
  switch (mode._tag) {
    case "override":
      return mode.path;
    case "compiled": {
      const sidecar = await statIfPresent(mode.path);
      if (sidecar === undefined)
        throw unavailable(mode.path, `Missing host-proxy shim sidecar: ${mode.path}`);
      return mode.path;
    }
    case "source": {
      const key = resolve(mode.path);
      const existing = inflight.get(key);
      if (existing !== undefined) return existing;
      const pending = prepareSource(input, mode.path).finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, pending);
      return pending;
    }
    default:
      return assertNever(mode);
  }
};

export const prepareHostProxyShimArtifact = (
  input: PrepareHostProxyShimArtifactInput,
): Effect.Effect<string, HostProxyTransportUnavailableError> =>
  Effect.tryPromise({
    try: () => runPrepare(input),
    catch: (cause) =>
      cause instanceof HostProxyTransportUnavailableError
        ? cause
        : unavailable(resolveMode(input).path, cause),
  });
