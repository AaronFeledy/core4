import { END_OF_ARCHIVE, TAR_BLOCK_SIZE, encodeUstarHeader, padToBlock } from "@lando/container-runtime/tar";

const SQLITE_ARCHIVE_NAME = "database.sqlite";

export const packSqliteTar = (payload: Uint8Array): Uint8Array => {
  const header = encodeUstarHeader({
    name: SQLITE_ARCHIVE_NAME,
    size: payload.byteLength,
    mode: 0o644,
    typeflag: "0",
  });
  const padding = padToBlock(payload.byteLength);
  const archive = new Uint8Array(header.byteLength + payload.byteLength + padding + END_OF_ARCHIVE.byteLength);
  archive.set(header);
  archive.set(payload, header.byteLength);
  archive.set(END_OF_ARCHIVE, header.byteLength + payload.byteLength + padding);
  return archive;
};

export const unpackSqliteTar = (archive: Uint8Array): Uint8Array | undefined => {
  if (archive.byteLength < TAR_BLOCK_SIZE) return undefined;
  const header = archive.subarray(0, TAR_BLOCK_SIZE);
  const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replaceAll("\0", "").trim();
  const size = Number.parseInt(sizeText, 8);
  if (!Number.isInteger(size) || size < 0) return undefined;
  const start = TAR_BLOCK_SIZE;
  const end = start + size;
  if (archive.byteLength < end) return undefined;
  return archive.subarray(start, end);
};
