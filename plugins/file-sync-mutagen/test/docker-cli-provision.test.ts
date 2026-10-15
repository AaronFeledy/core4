import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { ToolExtractError, ToolInstallPathError, ToolManifestError } from "@lando/sdk/errors";
import { ToolManifest } from "@lando/sdk/schema";
import { ProcessRunner } from "@lando/sdk/services";
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect";

import {
  DOCKER_CLI_EXECUTABLE_SHA256,
  DOCKER_CLI_EXECUTABLE_SIZE_BYTES,
  DOCKER_CLI_TOOL_MANIFEST,
  dockerCliConfigDir,
  dockerCliInstallPath,
  makeDockerCliProvisioner,
  provisionDockerCli,
  readInstalledDockerCliStatus,
} from "../src/docker-cli-provision.ts";
import { makeZip } from "./support/archive-fixtures.ts";
import { makeFakeDownloader, sha256Hex } from "./support/fake-downloader.ts";

const executable = new TextEncoder().encode("MZ-private-docker-cli");
const archive = makeZip([{ name: "docker/docker.exe", bytes: executable }]);
const fixtureUrl = "https://example.test/docker-cli.zip";
const fixtureManifest = Schema.decodeUnknownSync(ToolManifest)({
  schemaVersion: 1,
  toolVersion: "fixture",
  artifacts: {
    "win32-x64": {
      url: fixtureUrl,
      sha256: sha256Hex(archive),
      sizeBytes: archive.byteLength,
      archive: "zip",
      member: "docker/docker.exe",
      installName: "mutagen-docker/docker.exe",
    },
  },
});
const fixtureProvisioner = makeDockerCliProvisioner({
  manifest: fixtureManifest,
  executableSha256: sha256Hex(executable),
  executableSizeBytes: executable.byteLength,
});

const processRunnerLayer = Layer.succeed(
  ProcessRunner,
  ProcessRunner.of({
    run: (options) =>
      Effect.succeed({
        exitCode: 0,
        stdout: options.cmd === "whoami" ? "S-1-5-21-1234\n" : "",
        stderr: "",
      }),
    stream: () => Stream.empty,
    streamWithExit: () => Stream.empty,
  }),
);
const testLayer = (downloader: ReturnType<typeof makeFakeDownloader>) =>
  Layer.mergeAll(downloader.layer, processRunnerLayer);

const dirs = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mutagen-docker-cli-"));
  return {
    root,
    binDir: join(root, "bin"),
    toolDownloadsDir: join(root, "downloads"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const input = (binDir: string, toolDownloadsDir: string) => ({
  binDir,
  toolDownloadsDir,
  platform: "win32",
  arch: "x64",
});

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const found = Cause.findErrorOption(exit.cause);
  if (found._tag !== "Some") throw new Error("expected tagged failure");
  return found.value;
};

describe("private Docker CLI pins", () => {
  test("pin the official Windows x64 archive and isolated install path", () => {
    expect(DOCKER_CLI_TOOL_MANIFEST.toolVersion).toBe("29.3.1");
    expect(Object.keys(DOCKER_CLI_TOOL_MANIFEST.artifacts)).toEqual(["win32-x64"]);
    expect(DOCKER_CLI_TOOL_MANIFEST.artifacts["win32-x64"]).toMatchObject({
      url: "https://download.docker.com/win/static/stable/x86_64/docker-29.3.1.zip",
      sha256: "9de0daaed958062d2005e2766c856a6671dd95e6202e1ac801c569e22dff7edf",
      sizeBytes: 46344787,
      archive: "zip",
      member: "docker/docker.exe",
      installName: "mutagen-docker/docker.exe",
    });
    expect(DOCKER_CLI_EXECUTABLE_SHA256).toBe(
      "ae4b16d8f152c03db73a9c9e33f89874ec640bfe2128dbd776a172059c94280d",
    );
    expect(DOCKER_CLI_EXECUTABLE_SIZE_BYTES).toBe(42072064);
    expect(dockerCliInstallPath("/private/bin")).toBe("/private/bin/mutagen-docker/docker.exe");
    expect(dockerCliConfigDir("/private/bin")).toBe("/private/bin/mutagen-docker/config");
  });

  test("production status rejects a missing pinned install", async () => {
    const paths = await dirs();
    try {
      expect(await readInstalledDockerCliStatus(paths.binDir, "win32", "x64")).toEqual({ isCurrent: false });
    } finally {
      await paths.cleanup();
    }
  });
});

describe("Docker CLI provisioner", () => {
  test("verifies a zip and installs only its Docker executable in the private bin directory", async () => {
    const paths = await dirs();
    const downloader = makeFakeDownloader();
    downloader.serve(fixtureUrl, archive);
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(exit._tag).toBe("Success");
      expect(downloader.downloadCalls()).toBe(1);
      expect(await readFile(dockerCliInstallPath(paths.binDir))).toEqual(Buffer.from(executable));
      expect(await readdir(dockerCliConfigDir(paths.binDir))).toEqual([]);
      expect(await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).toEqual({
        installedVersion: "fixture",
        isCurrent: true,
      });
    } finally {
      await paths.cleanup();
    }
  });

  test("is idempotent offline, then repairs missing and corrupted fingerprints from cache", async () => {
    const paths = await dirs();
    const downloader = makeFakeDownloader();
    downloader.serve(fixtureUrl, archive);
    const provision = (force?: boolean) =>
      Effect.scoped(
        fixtureProvisioner.provision({
          ...input(paths.binDir, paths.toolDownloadsDir),
          offline: true,
          ...(force === undefined ? {} : { force }),
        }),
      ).pipe(Effect.provide(testLayer(downloader)));
    try {
      const first = await Effect.runPromiseExit(
        Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(first._tag).toBe("Success");
      expect(downloader.downloadCalls()).toBe(1);
      expect((await Effect.runPromiseExit(provision()))._tag).toBe("Success");
      expect(downloader.downloadCalls()).toBe(1);

      await rm(`${dockerCliInstallPath(paths.binDir)}.sha256`);
      expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(false);
      expect((await Effect.runPromiseExit(provision()))._tag).toBe("Success");
      expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(true);

      const corrupted = new TextEncoder().encode("X".repeat(executable.byteLength));
      await writeFile(dockerCliInstallPath(paths.binDir), corrupted);
      await writeFile(`${dockerCliInstallPath(paths.binDir)}.sha256`, `${sha256Hex(corrupted)}\n`);
      expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(false);
      expect((await Effect.runPromiseExit(provision()))._tag).toBe("Success");
      expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(true);
      expect((await Effect.runPromiseExit(provision(true)))._tag).toBe("Success");
      expect(downloader.downloadCalls()).toBe(1);
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects a wrong archive checksum and a missing archive member", async () => {
    const paths = await dirs();
    const downloader = makeFakeDownloader();
    const wrong = makeZip([{ name: "docker/docker.exe", bytes: new TextEncoder().encode("wrong") }]);
    downloader.serve(fixtureUrl, wrong);
    try {
      const badChecksum = await Effect.runPromiseExit(
        Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(badChecksum._tag).toBe("Failure");
      expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(false);

      const missing = makeZip([{ name: "other.exe", bytes: executable }]);
      const missingManifest = Schema.decodeUnknownSync(ToolManifest)({
        ...fixtureManifest,
        artifacts: {
          "win32-x64": {
            ...fixtureManifest.artifacts["win32-x64"],
            sha256: sha256Hex(missing),
            sizeBytes: missing.byteLength,
          },
        },
      });
      const missingProvisioner = makeDockerCliProvisioner({
        manifest: missingManifest,
        executableSha256: sha256Hex(executable),
        executableSizeBytes: executable.byteLength,
      });
      downloader.serve(fixtureUrl, missing);
      const missingMember = await Effect.runPromiseExit(
        Effect.scoped(missingProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(failure(missingMember)).toBeInstanceOf(ToolExtractError);
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects unsupported hosts before downloading", async () => {
    const paths = await dirs();
    const downloader = makeFakeDownloader();
    try {
      for (const [platform, arch] of [
        ["darwin", "x64"],
        ["win32", "arm64"],
      ] as const) {
        const exit = await Effect.runPromiseExit(
          Effect.scoped(
            provisionDockerCli({ ...input(paths.binDir, paths.toolDownloadsDir), platform, arch }),
          ).pipe(Effect.provide(testLayer(downloader))),
        );
        expect(failure(exit)).toBeInstanceOf(ToolManifestError);
      }
      expect(downloader.downloadCalls()).toBe(0);
    } finally {
      await paths.cleanup();
    }
  });

  test("rejects symlinked private install parents and fingerprint files", async () => {
    const paths = await dirs();
    const downloader = makeFakeDownloader();
    downloader.serve(fixtureUrl, archive);
    const outside = join(paths.root, "outside");
    try {
      await mkdir(paths.binDir, { recursive: true });
      await mkdir(outside);
      await symlink(outside, dirname(dockerCliInstallPath(paths.binDir)));
      const escaped = await Effect.runPromiseExit(
        Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(failure(escaped)).toBeInstanceOf(ToolInstallPathError);
      expect(downloader.downloadCalls()).toBe(0);
      expect(await readdir(outside)).toEqual([]);
      await rm(dirname(dockerCliInstallPath(paths.binDir)));
      await mkdir(dirname(dockerCliInstallPath(paths.binDir)), { recursive: true });
      await writeFile(join(outside, "fingerprint"), "outside");
      await symlink(join(outside, "fingerprint"), `${dockerCliInstallPath(paths.binDir)}.sha256`);
      const linkedFingerprint = await Effect.runPromiseExit(
        Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
          Effect.provide(testLayer(downloader)),
        ),
      );
      expect(failure(linkedFingerprint)).toBeInstanceOf(ToolInstallPathError);
      expect(await readFile(join(outside, "fingerprint"), "utf8")).toBe("outside");
    } finally {
      await paths.cleanup();
    }
  });
});

test("nonempty private Docker config fails closed before execution or download", async () => {
  const paths = await dirs();
  const downloader = makeFakeDownloader();
  downloader.serve(fixtureUrl, archive);
  try {
    const first = await Effect.runPromiseExit(
      Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
        Effect.provide(testLayer(downloader)),
      ),
    );
    expect(first._tag).toBe("Success");
    await writeFile(join(dockerCliConfigDir(paths.binDir), "config.json"), "{}");
    expect((await fixtureProvisioner.readStatus(paths.binDir, "win32", "x64")).isCurrent).toBe(false);
    const second = await Effect.runPromiseExit(
      Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
        Effect.provide(testLayer(downloader)),
      ),
    );
    expect(failure(second)).toBeInstanceOf(ToolInstallPathError);
    expect(downloader.downloadCalls()).toBe(1);
  } finally {
    await paths.cleanup();
  }
});

test("rejects a symlinked Docker config directory before writing outside the bin root", async () => {
  const paths = await dirs();
  const downloader = makeFakeDownloader();
  downloader.serve(fixtureUrl, archive);
  const outside = join(paths.root, "outside-config");
  try {
    await mkdir(dirname(dockerCliConfigDir(paths.binDir)), { recursive: true });
    await mkdir(outside);
    await symlink(outside, dockerCliConfigDir(paths.binDir));
    const exit = await Effect.runPromiseExit(
      Effect.scoped(fixtureProvisioner.provision(input(paths.binDir, paths.toolDownloadsDir))).pipe(
        Effect.provide(testLayer(downloader)),
      ),
    );
    expect(failure(exit)).toBeInstanceOf(ToolInstallPathError);
    expect(downloader.downloadCalls()).toBe(0);
    expect(await readdir(outside)).toEqual([]);
  } finally {
    await paths.cleanup();
  }
});
