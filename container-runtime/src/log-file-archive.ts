import { END_OF_ARCHIVE, TAR_BLOCK_SIZE, encodeUstarHeader, padToBlock } from "./tar.ts";

export const archiveLogFileHelper = (payload: Uint8Array, directoryName: string): Uint8Array => {
  const padded = payload.byteLength + padToBlock(payload.byteLength);
  const directoryHeader = encodeUstarHeader({
    name: `${directoryName}/`,
    mode: 0o755,
    size: 0,
    typeflag: "5",
  });
  const fileHeader = encodeUstarHeader({
    name: `${directoryName}/lando-log-file-helper`,
    mode: 0o755,
    size: payload.byteLength,
    typeflag: "0",
  });
  const output = new Uint8Array(TAR_BLOCK_SIZE * 2 + padded + END_OF_ARCHIVE.length);
  output.set(directoryHeader, 0);
  output.set(fileHeader, TAR_BLOCK_SIZE);
  output.set(payload, TAR_BLOCK_SIZE * 2);
  output.set(END_OF_ARCHIVE, TAR_BLOCK_SIZE * 2 + padded);
  return output;
};
