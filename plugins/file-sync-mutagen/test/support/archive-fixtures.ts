import { gzipSync } from "node:zlib";

const writeAscii = (target: Uint8Array, offset: number, value: string): void => {
  target.set(new TextEncoder().encode(value), offset);
};

const makeTar = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array => {
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
    header[156] = 0x30;
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
  return concatenate(...chunks);
};

export const makeTarGz = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array =>
  new Uint8Array(gzipSync(Buffer.from(makeTar(members))));

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    const tableEntry = crcTable[(crc ^ byte) & 0xff];
    if (tableEntry === undefined) throw new Error("missing CRC table entry");
    crc = tableEntry ^ (crc >>> 8);
  }
  return ~crc >>> 0;
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

const concatenate = (...parts: Uint8Array[]): Uint8Array => {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
};

export const makeZip = (members: ReadonlyArray<{ name: string; bytes: Uint8Array }>): Uint8Array => {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const member of members) {
    const name = new TextEncoder().encode(member.name);
    const checksum = crc32(member.bytes);
    const local = concatenate(
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(member.bytes.length),
      u32(member.bytes.length),
      u16(name.length),
      u16(0),
      name,
    );
    locals.push(local, member.bytes);
    centrals.push(
      concatenate(
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(member.bytes.length),
        u32(member.bytes.length),
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
    offset += local.length + member.bytes.length;
  }
  const centralDirectory = concatenate(...centrals);
  const end = concatenate(
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(members.length),
    u16(members.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0),
  );
  return concatenate(...locals, centralDirectory, end);
};
