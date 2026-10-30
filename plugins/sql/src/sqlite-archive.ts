import { randomUUID } from "node:crypto";
import { rename } from "node:fs/promises";

import { END_OF_ARCHIVE, TAR_BLOCK_SIZE, encodeUstarHeader, padToBlock } from "@lando/container-runtime/tar";

import { isSqliteDatabaseHeader } from "./sqlite-header.ts";

const SQLITE_ARCHIVE_NAME = "database.sqlite";

export const packSqliteTar = (payload: Uint8Array): Uint8Array => {
  const header = encodeUstarHeader({
    name: SQLITE_ARCHIVE_NAME,
    size: payload.byteLength,
    mode: 0o644,
    typeflag: "0",
  });
  const padding = padToBlock(payload.byteLength);
  const archive = new Uint8Array(
    header.byteLength + payload.byteLength + padding + END_OF_ARCHIVE.byteLength,
  );
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

const parseTarSize = (header: Uint8Array): number | undefined => {
  const sizeText = new TextDecoder().decode(header.subarray(124, 136)).replaceAll("\0", "").trim();
  const size = Number.parseInt(sizeText, 8);
  return Number.isInteger(size) && size >= 0 ? size : undefined;
};

export const packSqliteTarFile = async (
  payloadPath: string,
  archivePath: string,
): Promise<{ readonly digest: string; readonly sizeBytes: number }> => {
  const size = Bun.file(payloadPath).size;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) {
    throw new Error("Cannot read SQLite snapshot payload size.");
  }
  const header = encodeUstarHeader({
    name: SQLITE_ARCHIVE_NAME,
    size,
    mode: 0o644,
    typeflag: "0",
  });
  const padding = padToBlock(size);
  const hasher = new Bun.CryptoHasher("sha256");
  const tempPath = `${archivePath}.tmp-${randomUUID()}`;
  const writer = Bun.file(tempPath).writer();
  const write = (bytes: Uint8Array) => {
    hasher.update(bytes);
    writer.write(bytes);
  };
  write(header);
  for await (const chunk of Bun.file(payloadPath).stream()) write(chunk);
  if (padding > 0) write(new Uint8Array(padding));
  write(END_OF_ARCHIVE);
  await writer.end();
  await rename(tempPath, archivePath);
  return {
    digest: hasher.digest("hex"),
    sizeBytes: header.byteLength + size + padding + END_OF_ARCHIVE.byteLength,
  };
};

export const unpackSqliteTarFile = async (archivePath: string, destPath: string): Promise<boolean> => {
  const archive = Bun.file(archivePath);
  if (archive.size < TAR_BLOCK_SIZE) return false;
  const header = new Uint8Array(await archive.slice(0, TAR_BLOCK_SIZE).arrayBuffer());
  const size = parseTarSize(header);
  if (size === undefined) return false;
  const start = TAR_BLOCK_SIZE;
  const end = start + size;
  if (archive.size < end) return false;
  const writer = Bun.file(destPath).writer();
  for await (const chunk of archive.slice(start, end).stream()) writer.write(chunk);
  await writer.end();
  const prefix = new Uint8Array(await Bun.file(destPath).slice(0, 16).arrayBuffer());
  return isSqliteDatabaseHeader(prefix);
};
