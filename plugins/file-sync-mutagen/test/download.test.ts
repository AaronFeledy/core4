import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import {
  MUTAGEN_VERSIONS_MANIFEST,
  MutagenBinaryChecksumError,
  MutagenBinaryDownloadError,
  type MutagenBinaryEntry,
  MutagenBinaryUnsupportedPlatformError,
  type MutagenVersionsManifest,
  hostPlatformKey,
  makeMutagenDownloader,
  mutagenAgentBinaryPath,
  mutagenHostBinaryPath,
  mutagenInstalledVersionPath,
  readInstalledMutagenStatus,
  readInstalledMutagenVersion,
} from "../src/download.ts";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const extractFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const opt = Cause.failureOption(exit.cause);
  if (opt._tag !== "Some") throw new Error("expected a tagged failure");
  return opt.value;
};

const run = <A, E>(eff: Effect.Effect<A, E, never>): Promise<Exit.Exit<A, E>> => Effect.runPromiseExit(eff);

const FAKE_ARCHIVE_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
const FAKE_ARCHIVE_SHA = sha256(FAKE_ARCHIVE_BYTES);
const FAKE_BINARY_BYTES = new Uint8Array([0xff, 0x01, 0x02, 0x03]);

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;

const textBytes = (value: string): Uint8Array => new TextEncoder().encode(value);

const concatBytes = (...chunks: Array<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

const u16 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
};

const u32 = (value: number): Uint8Array => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return ~crc >>> 0;
};

const makeStoredZipArchive = (
  entries: ReadonlyArray<{
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly withDescriptor?: boolean;
  }>,
): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = textBytes(entry.name);
    const crc = crc32(entry.bytes);
    const withDescriptor = entry.withDescriptor ?? false;
    const header = concatBytes(
      u32(ZIP_LOCAL_FILE_HEADER_SIGNATURE),
      u16(20),
      u16(withDescriptor ? 0x08 : 0),
      u16(0),
      u16(0),
      u16(0),
      u32(withDescriptor ? 0 : crc),
      u32(withDescriptor ? 0 : entry.bytes.byteLength),
      u32(withDescriptor ? 0 : entry.bytes.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
    );
    locals.push(header, entry.bytes);
    if (withDescriptor) {
      locals.push(
        concatBytes(
          u32(ZIP_DATA_DESCRIPTOR_SIGNATURE),
          u32(crc),
          u32(entry.bytes.byteLength),
          u32(entry.bytes.byteLength),
        ),
      );
    }

    centrals.push(
      concatBytes(
        u32(ZIP_CENTRAL_DIRECTORY_HEADER_SIGNATURE),
        u16(20),
        u16(20),
        u16(withDescriptor ? 0x08 : 0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(entry.bytes.byteLength),
        u32(entry.bytes.byteLength),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ),
    );

    offset += header.byteLength + entry.bytes.byteLength + (withDescriptor ? 16 : 0);
  }

  const centralDirectory = concatBytes(...centrals);
  const eocd = concatBytes(
    u32(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDirectory.byteLength),
    u32(offset),
    u16(0),
  );
  return concatBytes(...locals, centralDirectory, eocd);
};

const makeEntry = (
  key: string,
  binaryName: string,
  installName: string,
  isTarGz = true,
): MutagenBinaryEntry => ({
  url: `https://example.test/mutagen-${key}${isTarGz ? ".tar.gz" : ".zip"}`,
  sha256: FAKE_ARCHIVE_SHA,
  archiveFilename: `mutagen-${key}${isTarGz ? ".tar.gz" : ".zip"}`,
  binaryName,
  installName,
  sizeBytes: FAKE_ARCHIVE_BYTES.byteLength,
});

const TEST_MANIFEST: MutagenVersionsManifest = {
  schemaVersion: 1,
  mutagenVersion: "v0.99.0-test",
  host: {
    "linux-x64": makeEntry("linux-x64", "mutagen", "mutagen"),
    "linux-arm64": makeEntry("linux-arm64", "mutagen", "mutagen"),
    "darwin-x64": makeEntry("darwin-x64", "mutagen", "mutagen"),
    "darwin-arm64": makeEntry("darwin-arm64", "mutagen", "mutagen"),
    "win32-x64": makeEntry("win32-x64", "mutagen.exe", "mutagen.exe", false),
  },
  agents: {
    "linux-amd64": makeEntry("linux-amd64-agent", "mutagen-agent", "mutagen-agent-linux-amd64"),
    "linux-arm64": makeEntry("linux-arm64-agent", "mutagen-agent", "mutagen-agent-linux-arm64"),
    "linux-armv7": makeEntry("linux-armv7-agent", "mutagen-agent", "mutagen-agent-linux-armv7"),
  },
};

const fakeFetch = (): typeof fetch =>
  ((input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith("https://example.test/")) {
      return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
    }
    return Promise.resolve(new Response(FAKE_ARCHIVE_BYTES, { status: 200, statusText: "OK" }));
  }) as typeof fetch;

const fakeExtract = (): typeof import("../src/download.ts").defaultExtract =>
  (async (_archiveBytes, _entry) => FAKE_BINARY_BYTES) as never;

const writeInstalledBinary = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  await writeFile(`${path}.sha256`, `${sha256(bytes)}\n`, "utf-8");
};

const failingFetch = (): typeof fetch =>
  (() => {
    throw new Error("network unreachable");
  }) as typeof fetch;

describe("MUTAGEN_VERSIONS_MANIFEST", () => {
  test("schema version is 1 and mutagenVersion is non-empty", () => {
    expect(MUTAGEN_VERSIONS_MANIFEST.schemaVersion).toBe(1);
    expect(MUTAGEN_VERSIONS_MANIFEST.mutagenVersion.length).toBeGreaterThan(0);
  });

  test("host entries cover all five supported platforms", () => {
    const keys = Object.keys(MUTAGEN_VERSIONS_MANIFEST.host).sort();
    expect(keys).toEqual(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"]);
  });

  test("agent entries cover linux-amd64, linux-arm64, linux-armv7", () => {
    const keys = Object.keys(MUTAGEN_VERSIONS_MANIFEST.agents).sort();
    expect(keys).toEqual(["linux-amd64", "linux-arm64", "linux-armv7"]);
  });

  test("every host + agent entry has a 64-char hex sha256 and https URL", () => {
    const allEntries = [
      ...Object.values(MUTAGEN_VERSIONS_MANIFEST.host),
      ...Object.values(MUTAGEN_VERSIONS_MANIFEST.agents),
    ];
    for (const entry of allEntries) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.sha256).not.toMatch(/^0+$/);
      expect(entry.sizeBytes).toBeGreaterThan(0);
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.archiveFilename.length).toBeGreaterThan(0);
      expect(entry.binaryName.length).toBeGreaterThan(0);
      expect(entry.installName.length).toBeGreaterThan(0);
    }
  });
});

describe("hostPlatformKey", () => {
  test("linux + x64 → linux-x64", () => {
    expect(hostPlatformKey("linux", "x64")).toBe("linux-x64");
  });

  test("linux + arm64 → linux-arm64", () => {
    expect(hostPlatformKey("linux", "arm64")).toBe("linux-arm64");
  });

  test("darwin + arm64 → darwin-arm64", () => {
    expect(hostPlatformKey("darwin", "arm64")).toBe("darwin-arm64");
  });

  test("win32 + x64 → win32-x64", () => {
    expect(hostPlatformKey("win32", "x64")).toBe("win32-x64");
  });

  test("unsupported arch throws a tagged platform error", () => {
    expect(() => hostPlatformKey("linux", "arm")).toThrow(MutagenBinaryUnsupportedPlatformError);
    expect(() => hostPlatformKey("win32", "arm64")).toThrow(MutagenBinaryUnsupportedPlatformError);
  });
});

describe("mutagenHostBinaryPath", () => {
  test("returns bin/mutagen on linux", () => {
    const p = mutagenHostBinaryPath("/data", "linux");
    expect(p).toBe("/data/bin/mutagen");
  });

  test("returns bin/mutagen.exe on win32", () => {
    const p = mutagenHostBinaryPath("/data", "win32");
    expect(p).toBe("/data/bin/mutagen.exe");
  });
});

describe("mutagenAgentBinaryPath", () => {
  test("returns bin/mutagen-agents/mutagen-agent-<key>", () => {
    expect(mutagenAgentBinaryPath("/data", "linux-amd64")).toBe(
      "/data/bin/mutagen-agents/mutagen-agent-linux-amd64",
    );
  });
});

describe("mutagenInstalledVersionPath", () => {
  test("returns bin/.mutagen-installed-version", () => {
    expect(mutagenInstalledVersionPath("/data")).toBe("/data/bin/.mutagen-installed-version");
  });
});

describe("readInstalledMutagenVersion", () => {
  test("returns undefined when the version file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    try {
      const v = await readInstalledMutagenVersion(dir);
      expect(v).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns the trimmed version string when the file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    try {
      const versionPath = mutagenInstalledVersionPath(dir);
      await mkdir(dirname(versionPath), { recursive: true });
      await writeFile(versionPath, "v0.18.1\n", "utf-8");
      expect(await readInstalledMutagenVersion(dir)).toBe("v0.18.1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ZIP extraction", () => {
  test("extracts entries after one that uses a data descriptor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    const archiveBytes = makeStoredZipArchive([
      { name: "mutagen", bytes: textBytes("host-binary"), withDescriptor: true },
      { name: "mutagen-agent-linux-amd64", bytes: textBytes("agent-binary") },
    ]);
    const archiveSha = sha256(archiveBytes);
    const sharedZipEntry = {
      url: "https://example.test/mutagen-shared.zip",
      sha256: archiveSha,
      archiveFilename: "mutagen-shared.zip",
      binaryName: "mutagen",
      installName: "mutagen",
      sizeBytes: archiveBytes.byteLength,
    } satisfies MutagenBinaryEntry;

    const zipManifest: MutagenVersionsManifest = {
      schemaVersion: 1,
      mutagenVersion: "v0.99.0-test",
      host: {
        "linux-x64": sharedZipEntry,
      },
      agents: {
        "linux-amd64": {
          ...sharedZipEntry,
          binaryName: "mutagen-agent-linux-amd64",
          installName: "mutagen-agent-linux-amd64",
        },
      },
    };

    const zippedFetch: typeof fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url !== sharedZipEntry.url) {
        return Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }));
      }
      return Promise.resolve(new Response(archiveBytes, { status: 200, statusText: "OK" }));
    }) as typeof fetch;

    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: zipManifest,
          fetchImpl: zippedFetch,
        }),
      );
      expect(exit._tag).toBe("Success");
      expect(new Uint8Array(await readFile(mutagenHostBinaryPath(dir, "linux")))).toEqual(
        textBytes("host-binary"),
      );
      expect(new Uint8Array(await readFile(mutagenAgentBinaryPath(dir, "linux-amd64")))).toEqual(
        textBytes("agent-binary"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("makeMutagenDownloader().setup()", () => {
  test("installs host binary + all agent binaries and writes version marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    let fetchCalls = 0;
    const countingFetch: typeof fetch = ((url: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      return fakeFetch()(url);
    }) as typeof fetch;
    const sharedArchiveEntry = makeEntry("shared", "mutagen", "mutagen");
    const sharedArchiveManifest: MutagenVersionsManifest = {
      ...TEST_MANIFEST,
      host: Object.fromEntries(
        Object.keys(TEST_MANIFEST.host).map((key) => [key, sharedArchiveEntry]),
      ) as MutagenVersionsManifest["host"],
      agents: Object.fromEntries(
        Object.keys(TEST_MANIFEST.agents).map((key) => [key, sharedArchiveEntry]),
      ) as MutagenVersionsManifest["agents"],
    };
    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: sharedArchiveManifest,
          fetchImpl: countingFetch,
          extractImpl: fakeExtract(),
        }),
      );
      expect(exit._tag).toBe("Success");
      expect(fetchCalls).toBe(1);

      const hostBin = mutagenHostBinaryPath(dir);
      const hostBytes = await readFile(hostBin);
      expect(new Uint8Array(hostBytes)).toEqual(FAKE_BINARY_BYTES);
      expect(await readFile(`${hostBin}.sha256`, "utf-8")).toBe(`${sha256(FAKE_BINARY_BYTES)}\n`);

      for (const agentKey of Object.keys(TEST_MANIFEST.agents)) {
        const agentBin = mutagenAgentBinaryPath(dir, agentKey);
        const agentBytes = await readFile(agentBin);
        expect(new Uint8Array(agentBytes)).toEqual(FAKE_BINARY_BYTES);
      }

      const installed = await readInstalledMutagenVersion(dir);
      expect(installed).toBe(TEST_MANIFEST.mutagenVersion);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("installed status requires marker plus host and agent binaries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    try {
      const versionPath = mutagenInstalledVersionPath(dir);
      await mkdir(dirname(versionPath), { recursive: true });
      await writeFile(versionPath, `${TEST_MANIFEST.mutagenVersion}\n`, "utf-8");

      expect((await readInstalledMutagenStatus(dir, TEST_MANIFEST, "linux", "x64")).isCurrent).toBe(false);

      await writeFile(mutagenHostBinaryPath(dir, "linux"), FAKE_BINARY_BYTES);
      for (const agentKey of Object.keys(TEST_MANIFEST.agents)) {
        const agentPath = mutagenAgentBinaryPath(dir, agentKey);
        await mkdir(dirname(agentPath), { recursive: true });
        await writeFile(agentPath, FAKE_BINARY_BYTES);
      }

      expect((await readInstalledMutagenStatus(dir, TEST_MANIFEST, "linux", "x64")).isCurrent).toBe(false);

      await writeInstalledBinary(mutagenHostBinaryPath(dir, "linux"), FAKE_BINARY_BYTES);
      for (const agentKey of Object.keys(TEST_MANIFEST.agents)) {
        await writeInstalledBinary(mutagenAgentBinaryPath(dir, agentKey), FAKE_BINARY_BYTES);
      }

      expect((await readInstalledMutagenStatus(dir, TEST_MANIFEST, "linux", "x64")).isCurrent).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("installed status rejects binaries that no longer match their recorded fingerprints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    try {
      const versionPath = mutagenInstalledVersionPath(dir);
      await mkdir(dirname(versionPath), { recursive: true });
      await writeFile(versionPath, `${TEST_MANIFEST.mutagenVersion}\n`, "utf-8");

      await writeInstalledBinary(mutagenHostBinaryPath(dir, "linux"), FAKE_BINARY_BYTES);
      for (const agentKey of Object.keys(TEST_MANIFEST.agents)) {
        await writeInstalledBinary(mutagenAgentBinaryPath(dir, agentKey), FAKE_BINARY_BYTES);
      }
      expect((await readInstalledMutagenStatus(dir, TEST_MANIFEST, "linux", "x64")).isCurrent).toBe(true);

      await writeFile(mutagenAgentBinaryPath(dir, "linux-amd64"), new Uint8Array([0x00, 0x01]));
      expect((await readInstalledMutagenStatus(dir, TEST_MANIFEST, "linux", "x64")).isCurrent).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("marker-only installs are repaired instead of skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    let fetchCalls = 0;
    const countingFetch: typeof fetch = ((url: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      return fakeFetch()(url);
    }) as typeof fetch;

    try {
      const versionPath = mutagenInstalledVersionPath(dir);
      await mkdir(dirname(versionPath), { recursive: true });
      await writeFile(versionPath, `${TEST_MANIFEST.mutagenVersion}\n`, "utf-8");

      const downloader = makeMutagenDownloader();
      await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: TEST_MANIFEST,
          fetchImpl: countingFetch,
          extractImpl: fakeExtract(),
        }),
      );

      expect(fetchCalls).toBeGreaterThan(0);
      expect(new Uint8Array(await readFile(mutagenHostBinaryPath(dir)))).toEqual(FAKE_BINARY_BYTES);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("is idempotent — second call skips all downloads when version matches", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    let fetchCalls = 0;
    const countingFetch: typeof fetch = ((url: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      return fakeFetch()(url);
    }) as typeof fetch;

    try {
      const downloader = makeMutagenDownloader();
      const opts = {
        userDataRoot: dir,
        _testManifest: TEST_MANIFEST,
        fetchImpl: countingFetch,
        extractImpl: fakeExtract(),
      };
      await run(downloader.setup(opts));
      const callsAfterFirst = fetchCalls;
      expect(callsAfterFirst).toBeGreaterThan(0);

      fetchCalls = 0;
      await run(downloader.setup(opts));
      expect(fetchCalls).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("force: true re-downloads even when version already installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    let fetchCalls = 0;
    const countingFetch: typeof fetch = ((url: RequestInfo | URL): Promise<Response> => {
      fetchCalls += 1;
      return fakeFetch()(url);
    }) as typeof fetch;

    try {
      const downloader = makeMutagenDownloader();
      const opts = {
        userDataRoot: dir,
        _testManifest: TEST_MANIFEST,
        fetchImpl: countingFetch,
        extractImpl: fakeExtract(),
      };
      await run(downloader.setup(opts));
      fetchCalls = 0;

      await run(downloader.setup({ ...opts, force: true }));
      expect(fetchCalls).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("network error → MutagenBinaryDownloadError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: TEST_MANIFEST,
          fetchImpl: failingFetch(),
          extractImpl: fakeExtract(),
        }),
      );
      const err = extractFailure(exit);
      expect(err).toBeInstanceOf(MutagenBinaryDownloadError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("checksum mismatch → MutagenBinaryChecksumError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    const badArchiveBytes = new Uint8Array([0x00, 0x00]);
    const mismatchFetch: typeof fetch = ((_url: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(new Response(badArchiveBytes, { status: 200 }))) as typeof fetch;

    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: TEST_MANIFEST,
          fetchImpl: mismatchFetch,
          extractImpl: fakeExtract(),
        }),
      );
      const err = extractFailure(exit);
      expect(err).toBeInstanceOf(MutagenBinaryChecksumError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unsupported platform entry → MutagenBinaryUnsupportedPlatformError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    const emptyManifest: MutagenVersionsManifest = {
      ...TEST_MANIFEST,
      host: {},
    };

    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: emptyManifest,
          fetchImpl: fakeFetch(),
          extractImpl: fakeExtract(),
        }),
      );
      const err = extractFailure(exit);
      expect(err).toBeInstanceOf(MutagenBinaryUnsupportedPlatformError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("HTTP 404 → MutagenBinaryDownloadError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-test-"));
    const notFoundFetch: typeof fetch = ((_url: RequestInfo | URL): Promise<Response> =>
      Promise.resolve(new Response("not found", { status: 404, statusText: "Not Found" }))) as typeof fetch;

    try {
      const downloader = makeMutagenDownloader();
      const exit = await run(
        downloader.setup({
          userDataRoot: dir,
          _testManifest: TEST_MANIFEST,
          fetchImpl: notFoundFetch,
          extractImpl: fakeExtract(),
        }),
      );
      const err = extractFailure(exit);
      expect(err).toBeInstanceOf(MutagenBinaryDownloadError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
