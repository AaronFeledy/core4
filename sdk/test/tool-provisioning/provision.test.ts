import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ToolExtractError, ToolInstallPathError, ToolManifestError } from "@lando/sdk/errors";
import type { ToolManifest } from "@lando/sdk/schema";
import { provisionTool, resolveHostKey } from "@lando/sdk/tool-provisioning";

import { makeFakeDownloader, makeTarGz, makeZip, sha256Hex } from "./_fixtures.ts";

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

const HOST_BIN = text("#!/bin/sh\necho host-cli\n");
const AGENT_AMD64 = text("agent-amd64-binary");

// host tar.gz: { mutagen, mutagen-agents.tar.gz } ; nested agents has linux_amd64
const NESTED_AGENTS = makeTarGz([{ name: "linux_amd64", bytes: AGENT_AMD64 }]);
const HOST_TARGZ = makeTarGz([
  { name: "mutagen", bytes: HOST_BIN },
  { name: "mutagen-agents.tar.gz", bytes: NESTED_AGENTS },
]);
const HOST_TARGZ_SHA = sha256Hex(HOST_TARGZ);

const HOST_EXE = text("MZwindows-exe-bytes");
const HOST_ZIP = makeZip([
  { name: "mutagen.exe", bytes: HOST_EXE },
  { name: "mutagen-agents.tar.gz", bytes: NESTED_AGENTS },
]);
const HOST_ZIP_SHA = sha256Hex(HOST_ZIP);

const RAW_BIN = text("raw-mkcert-binary");
const RAW_SHA = sha256Hex(RAW_BIN);

interface Dirs {
  readonly binDir: string;
  readonly toolDownloadsDir: string;
  readonly cleanup: () => Promise<void>;
}

const makeDirs = async (): Promise<Dirs> => {
  const root = await mkdtemp(join(tmpdir(), "lando-tool-"));
  return {
    binDir: join(root, "bin"),
    toolDownloadsDir: join(root, "tool-downloads", "mutagen"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const run = <A, E>(eff: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(eff);

const failure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const opt = Cause.failureOption(exit.cause);
  if (opt._tag !== "Some") throw new Error("expected a tagged failure");
  return opt.value;
};

describe("resolveHostKey", () => {
  test("returns `${platform}-${arch}`", () => {
    expect(resolveHostKey("linux", "x64")).toBe("linux-x64");
    expect(resolveHostKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(resolveHostKey("win32", "x64")).toBe("win32-x64");
  });
});

const manifestFor = (key: string, entry: Record<string, unknown>): ToolManifest =>
  ({
    schemaVersion: 1,
    toolVersion: "v0.18.1",
    artifacts: { [key]: entry },
  }) as ToolManifest;

describe("provisionTool", () => {
  test("resolves host entry, extracts tar.gz member, installs under binDir with mode 0o755", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(exit._tag).toBe("Success");
      const installed = await readFile(join(dirs.binDir, "mutagen"));
      expect(new Uint8Array(installed)).toEqual(HOST_BIN);
      const info = await stat(join(dirs.binDir, "mutagen"));
      expect(info.mode & 0o777).toBe(0o755);
    } finally {
      await dirs.cleanup();
    }
  });

  test("extracts a nested-archive member (mutagen-agents.tar.gz/linux_amd64)", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/agent/linux-amd64", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen-agents.tar.gz/linux_amd64",
      installName: "mutagen-agents/mutagen-agent-linux-amd64",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64/agent/linux-amd64",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(exit._tag).toBe("Success");
      const installed = await readFile(join(dirs.binDir, "mutagen-agents", "mutagen-agent-linux-amd64"));
      expect(new Uint8Array(installed)).toEqual(AGENT_AMD64);
    } finally {
      await dirs.cleanup();
    }
  });

  test("extracts a zip member", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.zip", HOST_ZIP);
    const manifest = manifestFor("win32-x64/cli", {
      url: "https://example.test/host.zip",
      sha256: HOST_ZIP_SHA,
      archive: "zip",
      member: "mutagen.exe",
      installName: "mutagen.exe",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "win32-x64/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "win32",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(exit._tag).toBe("Success");
      const installed = await readFile(join(dirs.binDir, "mutagen.exe"));
      expect(new Uint8Array(installed)).toEqual(HOST_EXE);
    } finally {
      await dirs.cleanup();
    }
  });

  test("installs raw bytes when archive is omitted", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/mkcert", RAW_BIN);
    const manifest = manifestFor("linux-x64", {
      url: "https://example.test/mkcert",
      sha256: RAW_SHA,
      installName: "mkcert",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64",
            toolId: "mkcert",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(exit._tag).toBe("Success");
      const installed = await readFile(join(dirs.binDir, "mkcert"));
      expect(new Uint8Array(installed)).toEqual(RAW_BIN);
    } finally {
      await dirs.cleanup();
    }
  });

  test("unrepresented key fails with ToolManifestError", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "solaris-sparc/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(failure(exit)).toBeInstanceOf(ToolManifestError);
    } finally {
      await dirs.cleanup();
    }
  });

  test("installName escaping binDir fails with ToolInstallPathError", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "../evil",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(failure(exit)).toBeInstanceOf(ToolInstallPathError);
    } finally {
      await dirs.cleanup();
    }
  });

  test("missing archive member fails with ToolExtractError", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "does-not-exist",
      installName: "mutagen",
    });
    try {
      const exit = await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(failure(exit)).toBeInstanceOf(ToolExtractError);
    } finally {
      await dirs.cleanup();
    }
  });

  test("writes version marker and per-binary .sha256 fingerprint", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    try {
      await run(
        Effect.scoped(
          provisionTool({
            manifest,
            key: "linux-x64/cli",
            toolId: "mutagen",
            binDir: dirs.binDir,
            toolDownloadsDir: dirs.toolDownloadsDir,
            platform: "linux",
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      const marker = await readFile(join(dirs.binDir, ".mutagen.version"), "utf-8");
      expect(marker.trim()).toBe("v0.18.1");
      const fingerprint = await readFile(join(dirs.binDir, "mutagen.sha256"), "utf-8");
      expect(fingerprint.trim()).toBe(sha256Hex(HOST_BIN));
    } finally {
      await dirs.cleanup();
    }
  });

  test("idempotent re-run with matching version+fingerprint makes zero downloader calls", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    const input = {
      manifest,
      key: "linux-x64/cli",
      toolId: "mutagen",
      binDir: dirs.binDir,
      toolDownloadsDir: dirs.toolDownloadsDir,
      platform: "linux",
    };
    try {
      const first = await run(Effect.scoped(provisionTool(input)).pipe(Effect.provide(dl.layer)));
      expect(first._tag).toBe("Success");
      expect(dl.downloadCalls()).toBe(1);

      const second = await run(Effect.scoped(provisionTool(input)).pipe(Effect.provide(dl.layer)));
      expect(second._tag).toBe("Success");
      expect((second as Exit.Success<{ skipped: boolean }>).value.skipped).toBe(true);
      // Zero NEW download calls: the offline no-op short-circuits before the downloader.
      expect(dl.downloadCalls()).toBe(1);
    } finally {
      await dirs.cleanup();
    }
  });

  test("force re-provisions even when markers match", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    const base = {
      manifest,
      key: "linux-x64/cli",
      toolId: "mutagen",
      binDir: dirs.binDir,
      toolDownloadsDir: dirs.toolDownloadsDir,
      platform: "linux",
    };
    try {
      await run(Effect.scoped(provisionTool(base)).pipe(Effect.provide(dl.layer)));
      const callsAfterFirst = dl.downloadCalls();
      const forced = await run(
        Effect.scoped(provisionTool({ ...base, force: true })).pipe(Effect.provide(dl.layer)),
      );
      expect(forced._tag).toBe("Success");
      // archive byte-cache hit means no NEW network, but the install/extract re-ran (not skipped).
      expect((forced as Exit.Success<{ skipped: boolean }>).value.skipped).toBe(false);
      expect(dl.downloadCalls()).toBeGreaterThanOrEqual(callsAfterFirst);
    } finally {
      await dirs.cleanup();
    }
  });
});
