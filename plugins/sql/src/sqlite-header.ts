const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");

export const SQLITE_HEADER_BYTES = SQLITE_HEADER.byteLength;

export const isSqliteDatabaseHeader = (prefix: Uint8Array): boolean => {
  if (prefix.byteLength < SQLITE_HEADER.byteLength) return false;
  for (let index = 0; index < SQLITE_HEADER.byteLength; index += 1) {
    if (prefix[index] !== SQLITE_HEADER[index]) return false;
  }
  return true;
};
