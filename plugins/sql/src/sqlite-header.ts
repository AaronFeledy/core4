const SQLITE_HEADER = new TextEncoder().encode("SQLite format 3\0");

export const SQLITE_HEADER_BYTES = SQLITE_HEADER.byteLength;

export const isSqliteDatabaseHeader = (prefix: Uint8Array): boolean => {
  if (prefix.byteLength < SQLITE_HEADER.byteLength) return false;
  return SQLITE_HEADER.every((byte, index) => prefix[index] === byte);
};
