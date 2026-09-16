import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

const expectBytes = (actual: Uint8Array<ArrayBufferLike>, expected: Uint8Array<ArrayBufferLike>): void => {
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
};

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

  test("uses Linux artifacts for a WSL host", () => {
    // Given: a WSL host identity and a supported architecture.
    // When: the artifact key is resolved.
    const key = resolveHostKey("wsl", "arm64");

    // Then: the key uses the published Linux artifact family.
    expect(key).toBe("linux-arm64");
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
      expectBytes(installed, HOST_BIN);
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
      expectBytes(installed, AGENT_AMD64);
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
      expectBytes(installed, HOST_EXE);
    } finally {
      await dirs.cleanup();
    }
  });

  test.each([
    {
      archive: "tar.gz" as const,
      bytes: makeTarGz([
        { name: "mutagen", bytes: new Uint8Array(), typeflag: "2" },
        { name: "nested/mutagen", bytes: HOST_BIN },
      ]),
      url: "https://example.test/nonregular-first.tar.gz",
    },
    {
      archive: "zip" as const,
      bytes: makeZip([
        { name: "mutagen", bytes: new Uint8Array(), mode: 0o120777 },
        { name: "nested/mutagen", bytes: HOST_BIN },
      ]),
      url: "https://example.test/nonregular-first.zip",
    },
  ])("skips a nonregular $archive basename match and installs the later regular member", async (fixture) => {
    // Given: an archive whose first basename match is nonregular and whose second is a real executable.
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve(fixture.url, fixture.bytes);
    const manifest = manifestFor("linux-x64/cli", {
      url: fixture.url,
      sha256: sha256Hex(fixture.bytes),
      archive: fixture.archive,
      member: "mutagen",
      installName: "mutagen",
    });
    try {
      // When: the requested tool is provisioned.
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

      // Then: only the later regular member becomes the installed executable.
      expect(exit._tag).toBe("Success");
      expectBytes(await readFile(join(dirs.binDir, "mutagen")), HOST_BIN);
    } finally {
      await dirs.cleanup();
    }
  });

  test.each([
    {
      archive: "tar.gz" as const,
      bytes: makeTarGz([{ name: "mutagen", bytes: new Uint8Array(), typeflag: "2" }]),
      url: "https://example.test/nonregular-only.tar.gz",
    },
    {
      archive: "zip" as const,
      bytes: makeZip([{ name: "mutagen", bytes: new Uint8Array(), mode: 0o040755 }]),
      url: "https://example.test/nonregular-only.zip",
    },
  ])(
    "rejects an $archive archive with no regular member without changing an existing install",
    async (fixture) => {
      // Given: an installed tool and an archive whose only basename match is nonregular.
      const dirs = await makeDirs();
      const dl = makeFakeDownloader();
      dl.serve(fixture.url, fixture.bytes);
      await mkdir(dirs.binDir, { recursive: true });
      await writeFile(join(dirs.binDir, "mutagen"), HOST_BIN);
      await writeFile(join(dirs.binDir, "mutagen.sha256"), "existing-fingerprint\n");
      await writeFile(join(dirs.binDir, ".mutagen.version"), "existing-version\n");
      const manifest = manifestFor("linux-x64/cli", {
        url: fixture.url,
        sha256: sha256Hex(fixture.bytes),
        archive: fixture.archive,
        member: "mutagen",
        installName: "mutagen",
      });
      try {
        // When: forced provisioning bypasses the current-install short circuit.
        const exit = await run(
          Effect.scoped(
            provisionTool({
              manifest,
              key: "linux-x64/cli",
              toolId: "mutagen",
              binDir: dirs.binDir,
              toolDownloadsDir: dirs.toolDownloadsDir,
              platform: "linux",
              force: true,
            }),
          ).pipe(Effect.provide(dl.layer)),
        );

        // Then: extraction fails and the installed bytes remain untouched.
        expect(failure(exit)).toBeInstanceOf(ToolExtractError);
        expectBytes(await readFile(join(dirs.binDir, "mutagen")), HOST_BIN);
        expect(await readFile(join(dirs.binDir, "mutagen.sha256"), "utf8")).toBe("existing-fingerprint\n");
        expect(await readFile(join(dirs.binDir, ".mutagen.version"), "utf8")).toBe("existing-version\n");
      } finally {
        await dirs.cleanup();
      }
    },
  );

  test.each([
    {
      archive: "tar.gz" as const,
      bytes: makeTarGz([{ name: "mutagen", bytes: new Uint8Array() }]),
      url: "https://example.test/empty.tar.gz",
    },
    {
      archive: "zip" as const,
      bytes: makeZip([{ name: "mutagen", bytes: new Uint8Array() }]),
      url: "https://example.test/empty.zip",
    },
  ])("rejects an empty $archive executable before publishing install metadata", async (fixture) => {
    // Given: a regular archive member with no executable bytes.
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve(fixture.url, fixture.bytes);
    const manifest = manifestFor("linux-x64/cli", {
      url: fixture.url,
      sha256: sha256Hex(fixture.bytes),
      archive: fixture.archive,
      member: "mutagen",
      installName: "mutagen",
    });
    try {
      // When: provisioning extracts the empty member.
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

      // Then: the tagged extraction error precedes binary, fingerprint, and version publication.
      expect(failure(exit)).toBeInstanceOf(ToolExtractError);
      expect(await Bun.file(join(dirs.binDir, "mutagen")).exists()).toBe(false);
      expect(await Bun.file(join(dirs.binDir, "mutagen.sha256")).exists()).toBe(false);
      expect(await Bun.file(join(dirs.binDir, ".mutagen.version")).exists()).toBe(false);
    } finally {
      await dirs.cleanup();
    }
  });

  test("rejects a tar.gz archive that expands over the decompressed-size cap", async () => {
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
            maxDecompressedBytes: 1,
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      const error = failure(exit);
      expect(error).toBeInstanceOf(ToolExtractError);
      expect(error.message).toContain("decompressed-size cap");
    } finally {
      await dirs.cleanup();
    }
  });

  test("rejects a zip archive when cumulative stored entries exceed the decompressed-size cap", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const first = text("first-entry");
    const second = text("second-entry");
    const zip = makeZip([
      { name: "first", bytes: first },
      { name: "mutagen.exe", bytes: second },
    ]);
    dl.serve("https://example.test/cumulative.zip", zip);
    const manifest = manifestFor("win32-x64/cli", {
      url: "https://example.test/cumulative.zip",
      sha256: sha256Hex(zip),
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
            maxDecompressedBytes: first.byteLength + second.byteLength - 1,
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      const error = failure(exit);
      expect(error).toBeInstanceOf(ToolExtractError);
      expect(error.message).toContain("decompressed-size cap");
    } finally {
      await dirs.cleanup();
    }
  });

  test("extracts a zip archive just under the decompressed-size cap byte-for-byte", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const first = text("first-entry");
    const second = text("second-entry");
    const zip = makeZip([
      { name: "first", bytes: first },
      { name: "mutagen.exe", bytes: second },
    ]);
    dl.serve("https://example.test/under-cap.zip", zip);
    const manifest = manifestFor("win32-x64/cli", {
      url: "https://example.test/under-cap.zip",
      sha256: sha256Hex(zip),
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
            maxDecompressedBytes: first.byteLength + second.byteLength,
          }),
        ).pipe(Effect.provide(dl.layer)),
      );
      expect(exit._tag).toBe("Success");
      const installed = await readFile(join(dirs.binDir, "mutagen.exe"));
      expectBytes(installed, second);
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
      expectBytes(installed, RAW_BIN);
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

  test("installName through a symlinked parent escaping binDir fails before download", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    dl.serve("https://example.test/host.tar.gz", HOST_TARGZ);
    const outside = join(dirs.binDir, "..", "outside");
    await mkdir(dirs.binDir, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, join(dirs.binDir, "linked"));
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "linked/mutagen",
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
      expect(dl.downloadCalls()).toBe(0);
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

  test("legacy installed-version marker skips without downloader calls", async () => {
    const dirs = await makeDirs();
    const dl = makeFakeDownloader();
    const manifest = manifestFor("linux-x64/cli", {
      url: "https://example.test/host.tar.gz",
      sha256: HOST_TARGZ_SHA,
      archive: "tar.gz",
      member: "mutagen",
      installName: "mutagen",
    });
    await mkdir(dirs.binDir, { recursive: true });
    await writeFile(join(dirs.binDir, "mutagen"), HOST_BIN);
    await writeFile(join(dirs.binDir, "mutagen.sha256"), `${sha256Hex(HOST_BIN)}\n`, "utf-8");
    await writeFile(join(dirs.binDir, ".mutagen-installed-version"), "v0.18.1\n", "utf-8");
    const input = {
      manifest,
      key: "linux-x64/cli",
      toolId: "mutagen",
      binDir: dirs.binDir,
      toolDownloadsDir: dirs.toolDownloadsDir,
      platform: "linux",
    };
    try {
      const exit = await run(Effect.scoped(provisionTool(input)).pipe(Effect.provide(dl.layer)));
      expect(exit._tag).toBe("Success");
      if (!Exit.isSuccess(exit)) throw new Error("expected success");
      expect(exit.value.skipped).toBe(true);
      expect(dl.downloadCalls()).toBe(0);
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
      if (!Exit.isSuccess(second)) throw new Error("expected success");
      expect(second.value.skipped).toBe(true);
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
      if (!Exit.isSuccess(forced)) throw new Error("expected success");
      expect(forced.value.skipped).toBe(false);
      expect(dl.downloadCalls()).toBeGreaterThanOrEqual(callsAfterFirst);
    } finally {
      await dirs.cleanup();
    }
  });
});
