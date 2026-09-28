export const TAR_BLOCK_SIZE = 512;

export type UstarTypeflag = "0" | "2" | "5";

export interface UstarHeaderInput {
  readonly name: string;
  readonly size: number;
  readonly mode: number;
  readonly typeflag: UstarTypeflag;
  readonly linkName?: string;
  readonly uid?: number;
  readonly gid?: number;
  readonly mtime?: number;
}

export class UstarHeaderError extends Error {
  override readonly name = "UstarHeaderError";

  constructor(readonly field: "name" | "linkName" | "mode" | "uid" | "gid" | "size" | "mtime" | "checksum") {
    super(`Invalid ustar ${field}: the value must fit its header field without truncation.`);
  }
}

const encoder = new TextEncoder();

const octal = (value: number, width: number, field: UstarHeaderError["field"]): string => {
  const text = value.toString(8);
  if (!Number.isInteger(value) || value < 0 || text.length > width - 1) throw new UstarHeaderError(field);
  return `${text.padStart(width - 1, "0")}\0`;
};

const nameBytes = (value: string, field: "name" | "linkName"): Uint8Array => {
  const bytes = encoder.encode(value);
  if (bytes.length === 0 || bytes.length > 100) throw new UstarHeaderError(field);
  return bytes;
};

/**
 * `posix` writes the checksum as six octal digits, NUL, space (the ustar form).
 * `nul-terminated` writes seven octal digits and a NUL; the image build context
 * keeps this form because its byte digest feeds persisted build keys and image tags.
 */
export type UstarChecksumForm = "posix" | "nul-terminated";

export interface EncodeUstarHeaderOptions {
  readonly checksumForm?: UstarChecksumForm;
}

export const encodeUstarHeader = (
  input: UstarHeaderInput,
  options: EncodeUstarHeaderOptions = {},
): Uint8Array => {
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  const writeAscii = (offset: number, value: string, width: number): void => {
    header.set(encoder.encode(value).subarray(0, width), offset);
  };
  header.set(nameBytes(input.name, "name"));
  writeAscii(100, octal(input.mode, 8, "mode"), 8);
  writeAscii(108, octal(input.uid ?? 0, 8, "uid"), 8);
  writeAscii(116, octal(input.gid ?? 0, 8, "gid"), 8);
  writeAscii(124, octal(input.size, 12, "size"), 12);
  writeAscii(136, octal(input.mtime ?? 0, 12, "mtime"), 12);
  header.fill(0x20, 148, 156);
  header[156] = input.typeflag.charCodeAt(0);
  if (input.linkName !== undefined) header.set(nameBytes(input.linkName, "linkName"), 157);
  writeAscii(257, "ustar", 6);
  writeAscii(263, "00", 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(
    148,
    options.checksumForm === "nul-terminated"
      ? octal(checksum, 8, "checksum")
      : `${octal(checksum, 7, "checksum")} `,
    8,
  );
  return header;
};

export const padToBlock = (size: number): number =>
  (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;

/** Treat these bytes as read-only and use only as a set() source; use endOfArchive() for an owned buffer. */
export const END_OF_ARCHIVE: Uint8Array = new Uint8Array(TAR_BLOCK_SIZE * 2);

export const endOfArchive = (): Uint8Array => new Uint8Array(TAR_BLOCK_SIZE * 2);
