export class DebianArchiveError extends Error {}

export interface ArMember {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export interface TarEntry {
  readonly name: string;
  readonly kind: "file" | "symlink";
  readonly bytes?: Uint8Array;
  readonly linkname?: string;
}

export const parseArMembers = (archive: Uint8Array): ReadonlyArray<ArMember> => {
  if (Buffer.from(archive.subarray(0, 8)).toString("ascii") !== "!<arch>\n") {
    throw new DebianArchiveError("Not a Debian ar archive.");
  }
  const members: ArMember[] = [];
  let pos = 8;
  while (pos < archive.length) {
    if (pos + 60 > archive.length) throw new DebianArchiveError("Truncated ar header.");
    const header = Buffer.from(archive.subarray(pos, pos + 60)).toString("ascii");
    const sizeText = header.slice(48, 58).trim();
    const size = Number(sizeText);
    if (header.slice(58) !== "`\n" || !/^\d+$/u.test(sizeText) || !Number.isSafeInteger(size)) {
      throw new DebianArchiveError("Invalid ar member header.");
    }
    pos += 60;
    if (size > archive.length - pos) throw new DebianArchiveError("Truncated ar member.");
    members.push({
      name: header.slice(0, 16).trim().replace(/\/$/u, ""),
      bytes: archive.subarray(pos, pos + size),
    });
    pos += size + (size % 2);
  }
  return members;
};

const tarString = (header: Uint8Array, start: number, end: number): string => {
  const bytes = header.subarray(start, end);
  const zero = bytes.indexOf(0);
  return Buffer.from(zero < 0 ? bytes : bytes.subarray(0, zero)).toString("utf8");
};

export const parseTarEntries = (tar: Uint8Array): ReadonlyArray<TarEntry> => {
  const entries: TarEntry[] = [];
  let pos = 0;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((byte) => byte === 0)) return entries;
    const sizeText = tarString(header, 124, 136).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!/^[0-7]*$/u.test(sizeText) || !Number.isSafeInteger(size)) {
      throw new DebianArchiveError("Invalid tar member size.");
    }
    const base = tarString(header, 0, 100);
    const prefix = header[257] === 117 ? tarString(header, 345, 500) : "";
    const name = prefix.length === 0 ? base : `${prefix}/${base}`;
    pos += 512;
    if (size > tar.length - pos) throw new DebianArchiveError("Truncated tar member.");
    if (header[156] === 48 || header[156] === 0) {
      entries.push({ name, kind: "file", bytes: tar.subarray(pos, pos + size) });
    } else if (header[156] === 50) {
      entries.push({ name, kind: "symlink", linkname: tarString(header, 157, 257) });
    }
    pos += Math.ceil(size / 512) * 512;
  }
  if (pos !== tar.length) throw new DebianArchiveError("Truncated tar header.");
  return entries;
};
