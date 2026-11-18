const decoder = new TextDecoder();
const checksumOffset = 148;
const checksumLength = 8;

/**
 * Numeric header field: octal, or positive GNU base-256 (leading 0x80 byte),
 * which tar writers use for sizes of 8 GiB and up.
 */
export const parseNumeric = (bytes: Uint8Array): number => {
  const first = bytes[0] ?? 0;
  if ((first & 0x80) !== 0) {
    if (first !== 0x80) return Number.NaN;
    let value = 0;
    for (const byte of bytes.subarray(1)) value = value * 256 + byte;
    return value;
  }
  const text = decoder.decode(bytes).replaceAll("\0", "").trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) return Number.NaN;
  return Number.parseInt(text, 8);
};

/** Header text field, truncated at its first NUL. */
export const fieldText = (header: Uint8Array, start: number, length: number): string => {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/** Unsigned header checksum with the checksum field itself read as spaces. */
export const headerChecksum = (header: Uint8Array): number => {
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual +=
      index >= checksumOffset && index < checksumOffset + checksumLength ? 0x20 : (header[index] ?? 0);
  }
  return actual;
};

/** POSIX `ustar\0` and GNU `ustar  \0` both start with `ustar`. */
export const hasUstarMagic = (header: Uint8Array): boolean => fieldText(header, 257, 6).startsWith("ustar");

/** Split a member path into safe relative components, or undefined when unsafe. */
export const normalizeMemberPath = (raw: string): ReadonlyArray<string> | undefined => {
  if (raw.length === 0 || raw.includes("\0")) return undefined;
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[a-zA-Z]:[\\/]/u.test(raw)) return undefined;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return undefined;
    parts.push(part);
  }
  return parts;
};

const join = (parts: ReadonlyArray<string>): string => parts.join("/");

/** True when any parent component of the member path is a previously declared symlink. */
export const hasSymlinkParent = (parts: ReadonlyArray<string>, symlinks: ReadonlySet<string>): boolean => {
  for (let index = 1; index < parts.length; index += 1) {
    if (symlinks.has(join(parts.slice(0, index)))) return true;
  }
  return false;
};

/** Parse pax extended-header records, applying `path` and `linkpath` values. */
export const parsePaxRecords = (
  payload: Uint8Array,
  apply: (key: string, value: string) => void,
): boolean => {
  let offset = 0;
  while (offset < payload.byteLength) {
    const space = payload.indexOf(0x20, offset);
    if (space === -1) return false;
    const lengthText = decoder.decode(payload.subarray(offset, space));
    if (!/^\d+$/u.test(lengthText)) return false;
    const length = Number.parseInt(lengthText, 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > payload.byteLength) return false;
    const record = decoder.decode(payload.subarray(space + 1, offset + length)).replace(/\n$/u, "");
    const separator = record.indexOf("=");
    if (separator > 0) apply(record.slice(0, separator), record.slice(separator + 1));
    offset += length;
  }
  return true;
};
