/** Archive + Downloader test fixtures for the tool-provisioning helper tests. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { Effect, Layer, Stream } from "effect";

import { join } from "node:path";
import { DownloadFetchError } from "@lando/sdk/errors";
import type { DownloadRequest, DownloadResult } from "@lando/sdk/schema";
import { Downloader, type DownloaderShape } from "@lando/sdk/services";
import { persistVerifiedStream } from "@lando/sdk/verified-stream";

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const writeAscii = (target: Uint8Array, offset: number, value: string): void => {
  target.set(new TextEncoder().encode(value), offset);
};

/** Build a minimal POSIX (ustar) tar archive from named members. */
export const makeTar = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array => {
  const BLOCK = 512;
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(BLOCK);
    const nameBytes = new TextEncoder().encode(member.name);
    header.set(nameBytes.subarray(0, 100), 0);
    // mode, uid, gid (octal, null-terminated)
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    // size: 11 octal digits + space
    const sizeOctal = member.bytes.length.toString(8).padStart(11, "0");
    writeAscii(header, 124, `${sizeOctal} `);
    // mtime
    writeAscii(header, 136, "00000000000 ");
    // type flag '0' (regular file)
    header[156] = 0x30;
    // magic "ustar\0" + version "00"
    writeAscii(header, 257, "ustar\0");
    header[263] = 0x30;
    header[264] = 0x30;
    // checksum: fill with spaces, compute, write octal
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (const b of header) sum += b;
    const chk = sum.toString(8).padStart(6, "0");
    writeAscii(header, 148, `${chk}\0 `);
    chunks.push(header);
    // body padded to 512
    const padded = new Uint8Array(Math.ceil(member.bytes.length / BLOCK) * BLOCK);
    padded.set(member.bytes, 0);
    chunks.push(padded);
  }
  // two zero blocks terminator
  chunks.push(new Uint8Array(BLOCK * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

export const makeTarGz = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array =>
  new Uint8Array(gzipSync(Buffer.from(makeTar(members))));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
};
const u16 = (v: number): Uint8Array => {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, v, true);
  return b;
};
const u32 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

/** Build a STORED (uncompressed) zip archive from named members. */
export const makeZip = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = new TextEncoder().encode(m.name);
    const crc = crc32(m.bytes);
    const local = cat(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(m.bytes.length),
      u32(m.bytes.length),
      u16(name.length),
      u16(0),
      name,
    );
    locals.push(local, m.bytes);
    centrals.push(
      cat(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(m.bytes.length),
        u32(m.bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ),
    );
    offset += local.length + m.bytes.length;
  }
  const cd = cat(...centrals);
  const eocd = cat(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(members.length),
    u16(members.length),
    u32(cd.length),
    u32(offset),
    u16(0),
  );
  return cat(...locals, cd, eocd);
};

export interface FakeDownloaderHandle {
  readonly layer: Layer.Layer<Downloader>;
  readonly serve: (url: string, bytes: Uint8Array) => void;
  readonly downloadCalls: () => number;
}

/**
 * A fake `Downloader` Layer that honors the file-destination cache + offline
 * contract: a matching `expectedSha256` at an existing destination returns
 * `fromCache:true` WITHOUT counting a download; `offline:true` fails when not
 * cached. Otherwise it persists the served bytes atomically to the destination.
 */
export const makeFakeDownloader = (): FakeDownloaderHandle => {
  const sources = new Map<string, Uint8Array>();
  let calls = 0;

  const service: DownloaderShape = {
    id: "fake-downloader",
    capabilities: {
      schemes: ["https", "file"],
      memoryDownload: true,
      cacheAware: true,
      offline: true,
      mirror: false,
    },
    download: (request: DownloadRequest) =>
      Effect.gen(function* () {
        if (request.destination.kind !== "file") {
          return yield* Effect.die(new Error("fake downloader only supports file destinations"));
        }
        const { directory, filename } = request.destination;
        const destinationPath = join(directory, filename);

        if (request.expectedSha256 !== undefined) {
          const existing = yield* Effect.promise(async () => {
            try {
              const buf = await Bun.file(destinationPath).bytes();
              return { sha256: sha256Hex(buf), sizeBytes: buf.length };
            } catch {
              return undefined;
            }
          });
          if (existing !== undefined && existing.sha256 === request.expectedSha256) {
            return {
              url: request.url,
              kind: "file",
              path: destinationPath,
              sha256: existing.sha256,
              sizeBytes: existing.sizeBytes,
              fromCache: true,
            } satisfies DownloadResult;
          }
        }

        if (request.offline === true) {
          return yield* Effect.fail(
            new DownloadFetchError({ message: "offline and not cached", urlOrigin: request.url, status: 0 }),
          );
        }

        calls += 1;
        const body = sources.get(request.url);
        if (body === undefined) {
          return yield* Effect.fail(
            new DownloadFetchError({ message: "no source", urlOrigin: request.url, status: 404 }),
          );
        }
        const result = yield* persistVerifiedStream({
          body: Stream.fromIterable([body]),
          destinationPath,
          ...(request.expectedSha256 === undefined ? {} : { expectedSha256: request.expectedSha256 }),
        }).pipe(
          Effect.catchAll((cause) =>
            Effect.fail(new DownloadFetchError({ message: "persist failed", urlOrigin: request.url, cause })),
          ),
        );
        return {
          url: request.url,
          kind: "file",
          path: destinationPath,
          sha256: result.sha256,
          sizeBytes: result.sizeBytes,
          fromCache: false,
        } satisfies DownloadResult;
      }),
  };

  return {
    layer: Layer.succeed(Downloader, service),
    serve: (url, bytes) => void sources.set(url, bytes),
    downloadCalls: () => calls,
  };
};
