import { CONTAINER_HELPER_FILE } from "./container-helper.ts";
import { END_OF_ARCHIVE, TAR_BLOCK_SIZE, encodeUstarHeader, padToBlock } from "./tar.ts";

/** A tar with `directoryName/` and the helper executable inside it, for `PUT /archive`. */
export const archiveLogFileHelper = (helper: Uint8Array, directoryName: string): Uint8Array => {
  const padded = helper.byteLength + padToBlock(helper.byteLength);
  const directoryHeader = encodeUstarHeader({
    name: `${directoryName}/`,
    mode: 0o755,
    size: 0,
    typeflag: "5",
  });
  const fileHeader = encodeUstarHeader({
    name: `${directoryName}/${CONTAINER_HELPER_FILE}`,
    mode: 0o755,
    size: helper.byteLength,
    typeflag: "0",
  });
  const output = new Uint8Array(TAR_BLOCK_SIZE * 2 + padded + END_OF_ARCHIVE.length);
  output.set(directoryHeader, 0);
  output.set(fileHeader, TAR_BLOCK_SIZE);
  output.set(helper, TAR_BLOCK_SIZE * 2);
  output.set(END_OF_ARCHIVE, TAR_BLOCK_SIZE * 2 + padded);
  return output;
};
