import { TAR_BLOCK_SIZE } from "@lando/container-runtime/tar";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface TarMember {
  readonly name: string;
  readonly typeflag?: "0" | "1" | "2" | "3" | "4" | "5" | "6" | "x" | "g" | "L" | "K";
  readonly data?: Uint8Array | string;
  readonly linkname?: string;
  readonly mode?: number;
  readonly uid?: number;
}

export const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

const write = (block: Uint8Array, offset: number, value: string, length: number): void => {
  block.set(encoder.encode(value).subarray(0, length), offset);
};

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

const header = (member: TarMember, size: number): Uint8Array => {
  const block = new Uint8Array(TAR_BLOCK_SIZE);
  write(block, 0, member.name, 100);
  write(block, 100, octal(member.mode ?? 0o644, 8), 8);
  write(block, 108, octal(member.uid ?? 0, 8), 8);
  write(block, 116, octal(0, 8), 8);
  write(block, 124, octal(size, 12), 12);
  write(block, 136, octal(0, 12), 12);
  block.fill(0x20, 148, 156);
  write(block, 156, member.typeflag ?? "0", 1);
  write(block, 157, member.linkname ?? "", 100);
  write(block, 257, "ustar", 6);
  write(block, 263, "00", 2);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  write(block, 148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
};

const bytesOf = (data: Uint8Array | string | undefined): Uint8Array =>
  data === undefined ? new Uint8Array() : typeof data === "string" ? encoder.encode(data) : data;

/** Build a tar archive from explicit members; independent of the production encoder. */
export const tarArchive = (members: ReadonlyArray<TarMember>): Uint8Array => {
  const chunks: Uint8Array[] = [];
  for (const member of members) {
    const data = bytesOf(member.data);
    chunks.push(header(member, data.byteLength));
    if (data.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(data.byteLength / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE);
      padded.set(data);
      chunks.push(padded);
    }
  }
  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
  return concatBytes(chunks);
};

const field = (block: Uint8Array, start: number, length: number): string => {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
};

/** Parse a plain tar archive into its members for independent assertions. */
export const parseTarArchive = (
  archive: Uint8Array,
): ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }> => {
  const members: Array<{ readonly name: string; readonly data: Uint8Array }> = [];
  let offset = 0;
  while (offset + TAR_BLOCK_SIZE <= archive.byteLength) {
    const block = archive.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (block.every((byte) => byte === 0)) break;
    offset += TAR_BLOCK_SIZE;
    const size = Number.parseInt(field(block, 124, 12) || "0", 8);
    const prefix = field(block, 345, 155);
    const name = field(block, 0, 100);
    members.push({
      name: prefix.length > 0 ? `${prefix}/${name}` : name,
      data: archive.subarray(offset, offset + size),
    });
    offset += Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }
  return members;
};

export const decompressArchive = (archive: Uint8Array, format: "tar" | "tar.gz" | "tar.zst"): Uint8Array =>
  format === "tar"
    ? archive
    : format === "tar.gz"
      ? Bun.gunzipSync(new Uint8Array(archive))
      : Bun.zstdDecompressSync(new Uint8Array(archive));
