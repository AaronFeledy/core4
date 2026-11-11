import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { type LandoPaths, makeLandoPaths } from "@lando/paths";
import { runWithCleanup } from "./runtime-bundle-cleanup.ts";

export const LINUX_BUNDLE_ENGINE_IDS = ["docker", "lando"] as const;
export type LinuxBundleEngineId = (typeof LINUX_BUNDLE_ENGINE_IDS)[number];

export interface EngineCommandRunner {
  /** Runs `cmd` with inherited output and rejects on a nonzero exit. */
  readonly execute: (cmd: ReadonlyArray<string>) => Promise<void>;
  /** Runs `cmd` and resolves its trimmed stdout, or rejects with its stderr. */
  readonly capture: (cmd: ReadonlyArray<string>) => Promise<string>;
}

export interface LinuxBundleBuildRequest {
  readonly context: string;
  /** Buildx-style `os/arch`, e.g. `linux/amd64`. */
  readonly platform: string;
  readonly buildArgs: ReadonlyArray<string>;
  readonly exportDir: string;
  readonly artifactName: string;
}

export interface LinuxBundleBuildEngine {
  readonly id: LinuxBundleEngineId;
  /** Resolves the `os/arch` that builds run on, or rejects with why this engine cannot build. */
  readonly probe: () => Promise<string>;
  /** Builds the Dockerfile's `bundle` target and writes `artifactName` into `exportDir`. */
  readonly build: (request: LinuxBundleBuildRequest) => Promise<void>;
}

export const engineCommandRunner = (env?: Readonly<Record<string, string>>): EngineCommandRunner => ({
  execute: async (cmd) => {
    const proc = Bun.spawn({ cmd: [...cmd], stdout: "inherit", stderr: "inherit", ...(env ? { env } : {}) });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`assemble-runtime-bundle: command failed (${exitCode}): ${cmd.join(" ")}`);
    }
  },
  capture: async (cmd) => {
    const proc = Bun.spawn({ cmd: [...cmd], stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(stderr.trim() || `${cmd.join(" ")} exited ${exitCode}`);
    return stdout.trim();
  },
});

const buildArgFlags = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args.flatMap((arg) => ["--build-arg", arg]);

export const dockerBuildEngine = (runner: EngineCommandRunner): LinuxBundleBuildEngine => ({
  id: "docker",
  probe: async () => {
    await runner.capture(["docker", "buildx", "version"]);
    return runner.capture(["docker", "version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
  },
  build: (request) =>
    runner.execute([
      "docker",
      "buildx",
      "build",
      "--platform",
      request.platform,
      "--target",
      "bundle",
      "--output",
      `type=local,dest=${request.exportDir}`,
      ...buildArgFlags(request.buildArgs),
      "--file",
      join(request.context, "Dockerfile"),
      request.context,
    ]),
});

/**
 * Builds through the Lando-managed Podman API with the runtime's own client in remote mode,
 * so the build joins the running service instead of opening its storage a second time.
 * Remote Podman cannot export with `--output`, so the archive leaves through a created,
 * never-started container. `--format docker` keeps the Dockerfile's `SHELL` instruction.
 */
export const landoRuntimeBuildEngine = (
  runner: EngineCommandRunner,
  paths: Pick<LandoPaths, "runtimeBinDir" | "providerSocketPath"> = makeLandoPaths(),
): LinuxBundleBuildEngine => {
  const client = join(paths.runtimeBinDir, "podman");
  const podman = [client, "--remote", "--url", `unix://${paths.providerSocketPath}`];
  return {
    id: "lando",
    probe: async () => {
      if (!(await Bun.file(client).exists())) throw new Error(`no Lando runtime client at ${client}`);
      return runner.capture([...podman, "info", "--format", "{{.Host.OS}}/{{.Host.Arch}}"]);
    },
    build: async (request) => {
      const tag = `localhost/lando-runtime-bundle-builder:${randomUUID()}`;
      let built = false;
      let container: string | undefined;
      await runWithCleanup(
        async () => {
          await runner.execute([
            ...podman,
            "build",
            "--platform",
            request.platform,
            "--target",
            "bundle",
            "--format",
            "docker",
            "--tag",
            tag,
            // Buildah sets BUILDPLATFORM but warns when the Dockerfile declares it; pass the probed platform.
            ...buildArgFlags([`BUILDPLATFORM=${request.platform}`, ...request.buildArgs]),
            "--file",
            join(request.context, "Dockerfile"),
            request.context,
          ]);
          built = true;
          container = await runner.capture([...podman, "create", tag, "/lando-bundle-export"]);
          await runner.execute([...podman, "cp", `${container}:/${request.artifactName}`, request.exportDir]);
        },
        () => [
          (async () => {
            if (container !== undefined) await runner.capture([...podman, "rm", "--force", container]);
            if (built) await runner.capture([...podman, "rmi", tag]);
          })(),
        ],
      );
    },
  };
};

const ENGINE_REMEDIATION: Readonly<Record<LinuxBundleEngineId, string>> = {
  docker: "Install Docker Engine with the Buildx plugin.",
  lando: "Run `lando setup`, then start the Lando runtime with `lando global:start`.",
};

/**
 * Picks the requested engine, or the first available of Docker Buildx then the Lando runtime.
 * An engine qualifies only when it builds natively on `platform`; bundles are never emulated.
 */
export const selectLinuxBundleBuildEngine = async (options: {
  readonly hostKey: string;
  readonly platform: string;
  readonly requested: LinuxBundleEngineId | undefined;
  readonly engines: Readonly<Record<LinuxBundleEngineId, LinuxBundleBuildEngine>>;
}): Promise<LinuxBundleBuildEngine> => {
  const candidates = options.requested === undefined ? LINUX_BUNDLE_ENGINE_IDS : [options.requested];
  const rejected: string[] = [];
  for (const id of candidates) {
    const engine = options.engines[id];
    try {
      const serverPlatform = await engine.probe();
      if (serverPlatform === options.platform) return engine;
      rejected.push(
        `  ${id}: builds on ${serverPlatform}, not ${options.platform}. Use a native ${options.platform} host; bundles are never emulated.`,
      );
    } catch (cause) {
      const reason = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
      rejected.push(`  ${id}: ${reason}. ${ENGINE_REMEDIATION[id]}`);
    }
  }
  throw new Error(
    [
      `assemble-runtime-bundle: ${options.hostKey} builds in a container, and no native ${options.platform} build engine is available.`,
      ...rejected,
      ...(options.requested === undefined ? ["Choose one with --engine docker or --engine lando."] : []),
    ].join("\n"),
  );
};
