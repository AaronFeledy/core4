import { randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

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

const tarText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).replace(/\0.*$/su, "");

const tarOctal = (bytes: Uint8Array): number | undefined => {
  const text = new TextDecoder().decode(bytes).replaceAll("\0", "").trim();
  if (!/^[0-7]+$/u.test(text)) return undefined;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const sqliteTarSize = (header: Uint8Array): number | undefined => {
  if (header.byteLength !== TAR_BLOCK_SIZE) return undefined;
  if (
    tarText(header.subarray(0, 100)) !== SQLITE_ARCHIVE_NAME ||
    header[156] !== 48 ||
    tarText(header.subarray(257, 263)) !== "ustar" ||
    tarText(header.subarray(263, 265)) !== "00" ||
    header.subarray(157, 257).some((byte) => byte !== 0) ||
    header.subarray(345, 500).some((byte) => byte !== 0)
  )
    return undefined;
  const expectedChecksum = tarOctal(header.subarray(148, 156));
  const actualChecksum = header.reduce(
    (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
    0,
  );
  return expectedChecksum === actualChecksum ? tarOctal(header.subarray(124, 136)) : undefined;
};

const archiveLength = (size: number): number =>
  TAR_BLOCK_SIZE + size + padToBlock(size) + END_OF_ARCHIVE.byteLength;

export const unpackSqliteTar = (archive: Uint8Array): Uint8Array | undefined => {
  const size = sqliteTarSize(archive.subarray(0, TAR_BLOCK_SIZE));
  if (size === undefined || archive.byteLength !== archiveLength(size)) return undefined;
  const end = TAR_BLOCK_SIZE + size;
  if (archive.subarray(end).some((byte) => byte !== 0)) return undefined;
  const payload = archive.subarray(TAR_BLOCK_SIZE, end);
  return isSqliteDatabaseHeader(payload) ? payload : undefined;
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
  try {
    try {
      write(header);
      let copied = 0;
      for await (const chunk of Bun.file(payloadPath).stream()) {
        copied += chunk.byteLength;
        if (copied > size) throw new Error("SQLite snapshot payload changed while archiving.");
        write(chunk);
      }
      if (copied !== size) throw new Error("SQLite snapshot payload changed while archiving.");
      if (padding > 0) write(new Uint8Array(padding));
      write(END_OF_ARCHIVE);
    } finally {
      await writer.end();
    }
    const archiveHandle = await open(tempPath, "r+");
    try {
      await archiveHandle.chmod(0o600);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await rename(tempPath, archivePath);
    const directoryHandle = await open(dirname(archivePath), "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
    return {
      digest: hasher.digest("hex"),
      sizeBytes: archiveLength(size),
    };
  } finally {
    await rm(tempPath, { force: true });
  }
};

export const unpackSqliteTarFile = async (archivePath: string, destPath: string): Promise<boolean> => {
  const archive = Bun.file(archivePath);
  if (archive.size < TAR_BLOCK_SIZE) return false;
  const header = new Uint8Array(await archive.slice(0, TAR_BLOCK_SIZE).arrayBuffer());
  const size = sqliteTarSize(header);
  if (size === undefined || size < 16) return false;
  const start = TAR_BLOCK_SIZE;
  const end = start + size;
  if (archive.size !== archiveLength(size)) return false;
  const trailer = new Uint8Array(await archive.slice(end).arrayBuffer());
  if (trailer.some((byte) => byte !== 0)) return false;
  const prefix = new Uint8Array(await archive.slice(start, start + 16).arrayBuffer());
  if (!isSqliteDatabaseHeader(prefix)) return false;
  const tempPath = `${destPath}.tmp-${randomUUID()}`;
  try {
    const writer = Bun.file(tempPath).writer();
    try {
      for await (const chunk of archive.slice(start, end).stream()) writer.write(chunk);
    } finally {
      await writer.end();
    }
    await chmod(tempPath, 0o644);
    await rename(tempPath, destPath);
    return true;
  } finally {
    await rm(tempPath, { force: true });
  }
};
