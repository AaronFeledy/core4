import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Exit } from "effect";

import { ToolManifestError } from "@lando/sdk/errors";

import {
  MKCERT_TOOL_MANIFEST,
  MKCERT_TOOL_VERSION,
  mkcertInstallName,
  mkcertInstallPath,
  provisionMkcert,
  readInstalledMkcertStatus,
} from "../src/provision.ts";
import { MKCERT_BIN, failure, makeTempDirs, patchHostBinary } from "./_fixtures.ts";
import { makeFakeDownloader } from "./support/fake-downloader.ts";

describe("MKCERT_TOOL_MANIFEST", () => {
  test("pins every supported host key to a plain upstream binary", () => {
    // Given / When the committed manifest is decoded
    // Then every host Lando ships on has a pinned, archive-free artifact
    expect(MKCERT_TOOL_MANIFEST.schemaVersion).toBe(1);
    expect(MKCERT_TOOL_VERSION).toBe(MKCERT_TOOL_MANIFEST.toolVersion);
    expect(Object.keys(MKCERT_TOOL_MANIFEST.artifacts).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ]);

    for (const [key, entry] of Object.entries(MKCERT_TOOL_MANIFEST.artifacts)) {
      expect(entry.url.startsWith("https://")).toBe(true);
      expect(entry.url).toContain(MKCERT_TOOL_VERSION);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.archive).toBeUndefined();
      expect(entry.member).toBeUndefined();
      expect(entry.installName).toBe(key.startsWith("win32-") ? "mkcert.exe" : "mkcert");
    }
  });
});

describe("mkcertInstallPath", () => {
  test("uses the platform-specific executable name", () => {
    expect(mkcertInstallName("linux")).toBe("mkcert");
    expect(mkcertInstallName("win32")).toBe("mkcert.exe");
    expect(mkcertInstallPath("/data/bin", "darwin")).toBe(join("/data/bin", "mkcert"));
    expect(mkcertInstallPath("/data/bin", "win32")).toBe(join("/data/bin", "mkcert.exe"));
  });
});

describe("provisionMkcert", () => {
  test("installs the pinned binary and records the version marker", async () => {
    const dirs = await makeTempDirs("lando-mkcert-provision-");
    const patch = patchHostBinary("linux-x64", MKCERT_BIN, "mkcert");
    try {
      const downloader = makeFakeDownloader();
      downloader.serve(patch.url, MKCERT_BIN);

      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          provisionMkcert({
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
            arch: "x64",
          }),
        ).pipe(Effect.provide(downloader.layer)),
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      const installed = await readFile(mkcertInstallPath(dirs.binDir, "linux"));
      expect(Array.from(installed)).toEqual(Array.from(MKCERT_BIN));

      const status = await readInstalledMkcertStatus(dirs.binDir, "linux", "x64");
      expect(status.installedVersion).toBe(MKCERT_TOOL_VERSION);
      expect(status.isCurrent).toBe(true);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("is a no-op on the second run and reinstalls under force", async () => {
    const dirs = await makeTempDirs("lando-mkcert-provision-");
    const patch = patchHostBinary("linux-x64", MKCERT_BIN, "mkcert");
    try {
      const downloader = makeFakeDownloader();
      downloader.serve(patch.url, MKCERT_BIN);
      const input = {
        binDir: dirs.binDir,
        toolDownloadsDir: dirs.toolDownloadsDir,
        platform: "linux",
        arch: "x64",
      };

      const installedAt = async (): Promise<number> =>
        (await stat(mkcertInstallPath(dirs.binDir, "linux"))).mtimeMs;
      const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

      await Effect.runPromise(Effect.scoped(provisionMkcert(input)).pipe(Effect.provide(downloader.layer)));
      const afterFirstInstall = await installedAt();
      const afterFirstDownloads = downloader.downloadCalls();

      await settle();
      await Effect.runPromise(Effect.scoped(provisionMkcert(input)).pipe(Effect.provide(downloader.layer)));
      expect(await installedAt()).toBe(afterFirstInstall);
      expect(downloader.downloadCalls()).toBe(afterFirstDownloads);

      await settle();
      await Effect.runPromise(
        Effect.scoped(provisionMkcert({ ...input, force: true })).pipe(Effect.provide(downloader.layer)),
      );
      expect(await installedAt()).not.toBe(afterFirstInstall);
    } finally {
      patch.restore();
      await dirs.cleanup();
    }
  });

  test("fails closed with ToolManifestError on an unsupported host", async () => {
    const dirs = await makeTempDirs("lando-mkcert-provision-");
    try {
      const downloader = makeFakeDownloader();
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          provisionMkcert({
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
            arch: "riscv64",
          }),
        ).pipe(Effect.provide(downloader.layer)),
      );

      expect(failure(exit)).toBeInstanceOf(ToolManifestError);
      expect(downloader.downloadCalls()).toBe(0);
    } finally {
      await dirs.cleanup();
    }
  });
});
