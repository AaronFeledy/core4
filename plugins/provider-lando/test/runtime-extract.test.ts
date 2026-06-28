import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { Cause, Effect, Exit } from "effect";

import {
  type ExtractEntries,
  ProviderRuntimeExtractError,
  extractRuntimeArchiveEntries,
  installRuntimeBundle,
} from "../src/runtime-extract.ts";

const encoder = new TextEncoder();

const expectFailure = <A, E>(exit: Exit.Exit<A, E>): E => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected effect to fail");
  }
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error(`expected a tagged failure, got ${JSON.stringify(exit.cause)}`);
  }
  return failure.value;
};

const octal = (value: number, length: number): string => `${value.toString(8).padStart(length - 1, "0")}\0`;

interface TarEntrySpec {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly mode?: number;
  readonly typeflag?: string;
}

const splitTarName = (path: string): { readonly name: string; readonly prefix: string } => {
  if (path.length <= 100) return { name: path, prefix: "" };
  const slash = path.lastIndexOf("/", path.length - 101);
  if (slash <= 0) throw new Error(`test tar path is too long: ${path}`);
  return { name: path.slice(slash + 1), prefix: path.slice(0, slash) };
};

const tarHeader = (entry: TarEntrySpec): Uint8Array => {
  const bytes = entry.bytes ?? new Uint8Array();
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarName(entry.path);
  header.set(Buffer.from(name, "latin1"), 0);
  header.set(Buffer.from(octal(entry.mode ?? 0o644, 8), "ascii"), 100);
  header.set(Buffer.from(octal(0, 8), "ascii"), 108);
  header.set(Buffer.from(octal(0, 8), "ascii"), 116);
  header.set(Buffer.from(octal(bytes.byteLength, 12), "ascii"), 124);
  header.set(Buffer.from(octal(0, 12), "ascii"), 136);
  header.fill(0x20, 148, 156);
  header[156] = (entry.typeflag ?? "0").charCodeAt(0);
  header.set(Buffer.from("ustar\0", "ascii"), 257);
  header.set(Buffer.from("00", "ascii"), 263);
  header.set(Buffer.from(prefix, "latin1"), 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(Buffer.from(octal(checksum, 8), "ascii"), 148);
  return header;
};

const buildTarGz = (entries: ReadonlyArray<TarEntrySpec>): Uint8Array => {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const bytes = entry.bytes ?? new Uint8Array();
    chunks.push(tarHeader(entry));
    chunks.push(bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  return gzipSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
};

const crc32Table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crc32Table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const buildStoredZip = (name: string, bytes: Uint8Array, mode = 0o100644): Uint8Array => {
  const nameBytes = Buffer.from(name, "utf8");
  const crc = crc32(bytes);
  const local = Buffer.alloc(30 + nameBytes.byteLength);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(bytes.byteLength, 18);
  local.writeUInt32LE(bytes.byteLength, 22);
  local.writeUInt16LE(nameBytes.byteLength, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.byteLength);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x031e, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(bytes.byteLength, 20);
  central.writeUInt32LE(bytes.byteLength, 24);
  central.writeUInt16LE(nameBytes.byteLength, 28);
  central.writeUInt32LE((mode << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.byteLength, 12);
  eocd.writeUInt32LE(local.byteLength + bytes.byteLength, 16);
  return Buffer.concat([local, Buffer.from(bytes), central, eocd]);
};

const makeTempRuntimeBinDir = async (): Promise<{
  readonly root: string;
  readonly runtimeBinDir: string;
}> => {
  const root = await mkdtemp(join(tmpdir(), "lando-runtime-extract-"));
  return { root, runtimeBinDir: join(root, "runtime", "bin") };
};

describe("installRuntimeBundle", () => {
  test("extracts a tar.gz runtime bundle and sets executable bits", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const archiveBytes = buildTarGz([
        { path: "podman", bytes: encoder.encode("podman") },
        { path: "gvproxy", bytes: encoder.encode("gvproxy") },
      ]);

      const result = await Effect.runPromise(
        installRuntimeBundle({ archiveBytes, version: "1.0.0", runtimeBinDir, platform: "linux" }),
      );

      expect(result).toEqual({ installed: true, runtimeBinDir, version: "1.0.0" });
      expect(existsSync(join(runtimeBinDir, "podman"))).toBe(true);
      expect(existsSync(join(runtimeBinDir, "gvproxy"))).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(join(runtimeBinDir, "podman")).mode & 0o111).not.toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("extracts a real stored zip runtime bundle", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const archiveBytes = buildStoredZip("nested/podman", encoder.encode("zip-podman"));

      await Effect.runPromise(
        installRuntimeBundle({ archiveBytes, version: "1.0.0", runtimeBinDir, platform: "linux" }),
      );

      expect(existsSync(join(runtimeBinDir, "nested", "podman"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects non-archive magic bytes", () => {
    expect(() => extractRuntimeArchiveEntries(encoder.encode("not an archive"))).toThrow(
      ProviderRuntimeExtractError,
    );
  });

  test("rejects tar traversal entries without writing runtimeBinDir", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const archiveBytes = buildTarGz([{ path: "../escape", bytes: encoder.encode("evil") }]);
      const exit = await Effect.runPromiseExit(
        installRuntimeBundle({ archiveBytes, version: "1.0.0", runtimeBinDir, platform: "linux" }),
      );
      const failure = expectFailure(exit);
      expect(failure).toBeInstanceOf(ProviderRuntimeExtractError);
      expect((failure as ProviderRuntimeExtractError).remediation).toBeDefined();
      expect(existsSync(runtimeBinDir)).toBe(false);
      expect(existsSync(join(dirname(runtimeBinDir), "escape"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects absolute tar entries without writing runtimeBinDir", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const archiveBytes = buildTarGz([{ path: "/etc/evil", bytes: encoder.encode("evil") }]);
      const exit = await Effect.runPromiseExit(
        installRuntimeBundle({ archiveBytes, version: "1.0.0", runtimeBinDir, platform: "linux" }),
      );
      expect(expectFailure(exit)).toBeInstanceOf(ProviderRuntimeExtractError);
      expect(existsSync(runtimeBinDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects tar symlink entries without writing runtimeBinDir", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const archiveBytes = buildTarGz([{ path: "podman", typeflag: "2" }]);
      const exit = await Effect.runPromiseExit(
        installRuntimeBundle({ archiveBytes, version: "1.0.0", runtimeBinDir, platform: "linux" }),
      );
      expect(expectFailure(exit)).toBeInstanceOf(ProviderRuntimeExtractError);
      expect(existsSync(runtimeBinDir)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not call extractImpl when the installed version marker matches", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      let calls = 0;
      const extractImpl: ExtractEntries = () => {
        calls += 1;
        return [{ path: "podman", bytes: encoder.encode("podman"), mode: 0o755 }];
      };

      const first = await Effect.runPromise(
        installRuntimeBundle({
          archiveBytes: new Uint8Array([1]),
          version: "1.0.0",
          runtimeBinDir,
          platform: "linux",
          extractImpl,
        }),
      );
      const second = await Effect.runPromise(
        installRuntimeBundle({
          archiveBytes: new Uint8Array([1]),
          version: "1.0.0",
          runtimeBinDir,
          platform: "linux",
          extractImpl,
        }),
      );

      expect(first.installed).toBe(true);
      expect(second).toEqual({ installed: false, runtimeBinDir, version: "1.0.0" });
      expect(calls).toBe(1);
      expect((await readFile(join(runtimeBinDir, ".runtime-installed-version"), "utf8")).trim()).toBe(
        "1.0.0",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("atomically replaces stale files on version change", async () => {
    const { root, runtimeBinDir } = await makeTempRuntimeBinDir();
    try {
      const install = (version: string, path: string) =>
        installRuntimeBundle({
          archiveBytes: new Uint8Array([1]),
          version,
          runtimeBinDir,
          platform: "linux",
          extractImpl: () => [{ path, bytes: encoder.encode(path), mode: 0o755 }],
        });

      await Effect.runPromise(install("1.0.0", "old-only"));
      await Effect.runPromise(install("2.0.0", "new-only"));

      expect(existsSync(join(runtimeBinDir, "old-only"))).toBe(false);
      expect(existsSync(join(runtimeBinDir, "new-only"))).toBe(true);
      expect((await readFile(join(runtimeBinDir, ".runtime-installed-version"), "utf8")).trim()).toBe(
        "2.0.0",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
