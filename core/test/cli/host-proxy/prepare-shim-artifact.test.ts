import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";

import { HostProxyTransportUnavailableError } from "@lando/sdk/errors";
import type { HostProxyContainerTarget } from "@lando/sdk/schema";

import {
  type HostProxyShimSpawner,
  prepareHostProxyShimArtifact,
} from "../../../src/cli/host-proxy/prepare-shim-artifact.ts";

const ARTIFACT_ENV = "LANDO_HOST_PROXY_SHIM_ARTIFACT";
const DIST_ENV = "LANDO_HOST_PROXY_SHIM_DIST_ROOT";
const SOURCE_EXEC = "/usr/local/bin/bun";
const COMPILED_EXEC = "/opt/lando/lando";
const OVERRIDE_PATH = "/tmp/lando-host-proxy-custom-shim-override";
const X64_TARGET = { os: "linux", arch: "x64" } as const satisfies HostProxyContainerTarget;
const ARM64_TARGET = { os: "linux", arch: "arm64" } as const satisfies HostProxyContainerTarget;

type SpawnCall = {
  readonly argv: readonly string[];
  readonly cwd: string;
};

const tempDirs: string[] = [];
let previousArtifact: string | undefined;
let previousDist: string | undefined;

beforeEach(() => {
  previousArtifact = process.env[ARTIFACT_ENV];
  previousDist = process.env[DIST_ENV];
  delete process.env[ARTIFACT_ENV];
  delete process.env[DIST_ENV];
});

afterEach(async () => {
  if (previousArtifact === undefined) delete process.env[ARTIFACT_ENV];
  else process.env[ARTIFACT_ENV] = previousArtifact;
  if (previousDist === undefined) delete process.env[DIST_ENV];
  else process.env[DIST_ENV] = previousDist;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const tempRoot = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-prepare-shim-"));
  tempDirs.push(dir);
  return dir;
};

const artifactPathFor = (distRoot: string, target: HostProxyContainerTarget): string =>
  join(distRoot, "host-proxy", `${target.os}-${target.arch}`, "lando-shim");

const outfileFrom = (argv: readonly string[]): string | undefined => {
  const index = argv.indexOf("--outfile");
  return index >= 0 ? argv[index + 1] : undefined;
};

const recordingSpawn = (input: {
  readonly calls: SpawnCall[];
  readonly exitCode?: number;
  readonly stderr?: string;
  readonly writeOutfile?: boolean;
  readonly gate?: Promise<void>;
}): HostProxyShimSpawner => {
  return async (argv, cwd) => {
    input.calls.push({ argv, cwd });
    if (input.gate !== undefined) await input.gate;
    const outfile = outfileFrom(argv);
    if (input.writeOutfile === true && outfile !== undefined) {
      await mkdir(dirname(outfile), { recursive: true });
      await writeFile(outfile, "prepared-shim-marker");
    }
    return { exitCode: input.exitCode ?? 0, stderr: input.stderr ?? "" };
  };
};

describe("prepareHostProxyShimArtifact", () => {
  test("compiles only linux-x64 when the source artifact is missing", async () => {
    // Given
    const distRoot = await tempRoot();
    const calls: SpawnCall[] = [];
    const spawn = recordingSpawn({ calls, writeOutfile: true });

    // When
    const prepared = await Effect.runPromise(
      prepareHostProxyShimArtifact({
        target: X64_TARGET,
        execPath: SOURCE_EXEC,
        distRoot,
        env: {},
        spawn,
      }),
    );

    // Then
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv ?? [];
    expect(argv.includes("--target=bun-linux-x64")).toBe(true);
    expect(argv.includes("--target=bun-linux-arm64")).toBe(false);
    const outfile = outfileFrom(argv);
    expect(outfile?.startsWith(join(distRoot, "host-proxy/linux-x64/"))).toBe(true);
    expect(prepared).toBe(artifactPathFor(distRoot, X64_TARGET));
  });

  test("compiles only linux-arm64 when the source artifact is missing", async () => {
    // Given
    const distRoot = await tempRoot();
    const calls: SpawnCall[] = [];
    const spawn = recordingSpawn({ calls, writeOutfile: true });

    // When
    const prepared = await Effect.runPromise(
      prepareHostProxyShimArtifact({
        target: ARM64_TARGET,
        execPath: SOURCE_EXEC,
        distRoot,
        env: {},
        spawn,
      }),
    );

    // Then
    expect(calls).toHaveLength(1);
    const argv = calls[0]?.argv ?? [];
    expect(argv.includes("--target=bun-linux-arm64")).toBe(true);
    expect(argv.includes("--target=bun-linux-x64")).toBe(false);
    const outfile = outfileFrom(argv);
    expect(outfile?.startsWith(join(distRoot, "host-proxy/linux-arm64/"))).toBe(true);
    expect(prepared).toBe(artifactPathFor(distRoot, ARM64_TARGET));
  });

  test("skips spawn when the artifact is newer than the source", async () => {
    // Given
    const root = await tempRoot();
    const distRoot = join(root, "dist");
    const sourcePath = join(root, "shim-bin.ts");
    const artifact = artifactPathFor(distRoot, X64_TARGET);
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(sourcePath, "export {}\n");
    await writeFile(artifact, "existing-shim");
    const now = Date.now() / 1000;
    await utimes(sourcePath, now - 20, now - 20);
    await utimes(artifact, now + 20, now + 20);
    const calls: SpawnCall[] = [];

    // When
    const prepared = await Effect.runPromise(
      prepareHostProxyShimArtifact({
        target: X64_TARGET,
        execPath: SOURCE_EXEC,
        distRoot,
        sourcePath,
        env: {},
        spawn: recordingSpawn({ calls }),
      }),
    );

    // Then
    expect(calls).toHaveLength(0);
    expect(prepared).toBe(artifact);
  });

  test("recompiles when the artifact is older than the source", async () => {
    // Given
    const root = await tempRoot();
    const distRoot = join(root, "dist");
    const sourcePath = join(root, "shim-bin.ts");
    const artifact = artifactPathFor(distRoot, X64_TARGET);
    await mkdir(dirname(artifact), { recursive: true });
    await writeFile(sourcePath, "export {}\n");
    await writeFile(artifact, "stale-shim");
    const now = Date.now() / 1000;
    await utimes(artifact, now - 20, now - 20);
    await utimes(sourcePath, now + 20, now + 20);
    const calls: SpawnCall[] = [];

    // When
    await Effect.runPromise(
      prepareHostProxyShimArtifact({
        target: X64_TARGET,
        execPath: SOURCE_EXEC,
        distRoot,
        sourcePath,
        env: {},
        spawn: recordingSpawn({ calls, writeOutfile: true }),
      }),
    );

    // Then
    expect(calls).toHaveLength(1);
  });

  test("fails tagged without spawn when compiled sidecar is missing", async () => {
    // Given
    const calls: SpawnCall[] = [];
    const expectedSidecar = join("/opt/lando", "host-proxy/linux-x64/lando-shim");

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        prepareHostProxyShimArtifact({
          target: X64_TARGET,
          execPath: COMPILED_EXEC,
          env: {},
          spawn: recordingSpawn({ calls }),
        }),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(HostProxyTransportUnavailableError);
    if (!(error instanceof HostProxyTransportUnavailableError)) return;
    expect(error._tag).toBe("HostProxyTransportUnavailableError");
    expect(error.socketPath).toBe(expectedSidecar);
    expect(calls).toHaveLength(0);
  });

  test("returns the env override path without spawn when the file is missing", async () => {
    // Given
    const calls: SpawnCall[] = [];

    // When
    const prepared = await Effect.runPromise(
      prepareHostProxyShimArtifact({
        target: X64_TARGET,
        execPath: SOURCE_EXEC,
        env: { [ARTIFACT_ENV]: OVERRIDE_PATH },
        spawn: recordingSpawn({ calls }),
      }),
    );

    // Then
    expect(prepared).toBe(OVERRIDE_PATH);
    expect(calls).toHaveLength(0);
  });

  test("maps a non-zero spawn exit to a tagged error", async () => {
    // Given
    const distRoot = await tempRoot();
    const calls: SpawnCall[] = [];
    const artifact = artifactPathFor(distRoot, X64_TARGET);

    // When
    const error = await Effect.runPromise(
      Effect.flip(
        prepareHostProxyShimArtifact({
          target: X64_TARGET,
          execPath: SOURCE_EXEC,
          distRoot,
          env: {},
          spawn: recordingSpawn({ calls, exitCode: 1, stderr: "compile failed" }),
        }),
      ),
    );

    // Then
    expect(error).toBeInstanceOf(HostProxyTransportUnavailableError);
    if (!(error instanceof HostProxyTransportUnavailableError)) return;
    expect(error._tag).toBe("HostProxyTransportUnavailableError");
    expect(error.socketPath).toBe(artifact);
  });

  test("shares one spawn for concurrent prepares of the same artifact path", async () => {
    // Given
    const distRoot = await tempRoot();
    const calls: SpawnCall[] = [];
    const { promise: gate, resolve: openGate } = Promise.withResolvers<void>();
    const spawn = recordingSpawn({ calls, writeOutfile: true, gate });
    const input = {
      target: X64_TARGET,
      execPath: SOURCE_EXEC,
      distRoot,
      env: {},
      spawn,
    };

    // When
    const pending = Effect.runPromise(
      Effect.all([prepareHostProxyShimArtifact(input), prepareHostProxyShimArtifact(input)], {
        concurrency: 2,
      }),
    );
    openGate();
    const prepared = await pending;

    // Then
    expect(calls).toHaveLength(1);
    expect(prepared).toEqual([artifactPathFor(distRoot, X64_TARGET), artifactPathFor(distRoot, X64_TARGET)]);
  });
});
