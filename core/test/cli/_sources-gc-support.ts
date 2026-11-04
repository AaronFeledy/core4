import { gzipSync } from "node:zlib";
import { sha256Hex } from "@lando/sdk/digest";
import type { ArchiveTransport } from "@lando/source-acquisition";

const writeAscii = (target: Uint8Array, offset: number, value: string): void => {
  target.set(new TextEncoder().encode(value), offset);
};

export const makeTar = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array; readonly typeflag?: number }>,
): Uint8Array => {
  const blockSize = 512;
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const header = new Uint8Array(blockSize);
    header.set(new TextEncoder().encode(member.name).subarray(0, 100), 0);
    writeAscii(header, 100, "0000644\0");
    writeAscii(header, 108, "0000000\0");
    writeAscii(header, 116, "0000000\0");
    writeAscii(header, 124, `${member.bytes.length.toString(8).padStart(11, "0")} `);
    writeAscii(header, 136, "00000000000 ");
    header[156] = member.typeflag ?? 0x30;
    writeAscii(header, 257, "ustar\0");
    header[263] = 0x30;
    header[264] = 0x30;
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    writeAscii(header, 148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header);
    const padded = new Uint8Array(Math.ceil(member.bytes.length / blockSize) * blockSize);
    padded.set(member.bytes);
    chunks.push(padded);
  }
  chunks.push(new Uint8Array(blockSize * 2));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
};

export const makeTarGz = (
  members: ReadonlyArray<{ readonly name: string; readonly bytes: Uint8Array; readonly typeflag?: number }>,
): Uint8Array => new Uint8Array(gzipSync(Buffer.from(makeTar(members))));

export const sha256Of = (bytes: Uint8Array): string => sha256Hex(bytes);

export const makeFakeArchive = (): {
  readonly transport: ArchiveTransport;
  set: (url: string, bytes: Uint8Array) => void;
} => {
  const files = new Map<string, Uint8Array>();
  return {
    set: (url, bytes) => void files.set(url, bytes),
    transport: {
      fetch: async (url) => {
        const bytes = files.get(url);
        if (bytes === undefined) throw new Error(`missing archive ${url}`);
        return bytes;
      },
    },
  };
};
