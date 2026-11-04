import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SourceAcquisitionError } from "./errors.ts";
export type { ArchiveTransport } from "./types.ts";

const safeEntryPath = (entryName: string): string => {
  const segments = entryName
    .replace(/\\/gu, "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".");
  if (
    segments.some((part) => part === "..") ||
    /^[a-z]:/iu.test(segments[0] ?? "") ||
    entryName.includes("\0")
  ) {
    throw new SourceAcquisitionError({
      message: `Tarball entry escapes the extraction directory: ${entryName}`,
      source: "archive",
      kind: "extract-failed",
      remediation: "The archive contains an unsafe path; re-publish it without parent-directory entries.",
    });
  }
  return segments.join("/");
};

export const extractArchive = async (
  archiveBytes: Uint8Array,
  destDir: string,
  options?: { readonly maxDecompressedBytes?: number },
): Promise<void> => {
  const buffer = Buffer.from(archiveBytes);
  const maxOutputLength = options?.maxDecompressedBytes ?? 2 * 1024 ** 3;
  let tar = buffer;
  if (archiveBytes[0] === 0x1f && archiveBytes[1] === 0x8b) {
    try {
      tar = gunzipSync(buffer, { maxOutputLength });
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ERR_BUFFER_TOO_LARGE")
        throw new SourceAcquisitionError({
          message: `Tarball recipe source tarball exceeded the decompressed-size cap of ${maxOutputLength} bytes.`,
          source: "archive",
          kind: "extract-failed",
          remediation:
            "The archive is unreasonably large or likely malformed; re-publish a smaller archive and retry.",
        });
      throw cause;
    }
  }
  await mkdir(destDir, { recursive: true });
  let pos = 0;
  let longName: string | undefined;
  while (pos + 512 <= tar.length) {
    const header = tar.subarray(pos, pos + 512);
    if (header[0] === 0) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/su, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/su, "");
    const sizeOctal = header
      .subarray(124, 136)
      .toString("ascii")
      .replace(/[^0-7]/gu, "");
    const size = sizeOctal.length > 0 ? Number.parseInt(sizeOctal, 8) : 0;
    const type = header[156];
    pos += 512;
    const start = pos;
    pos += Math.ceil(size / 512) * 512;
    if (start + size > tar.length)
      throw new SourceAcquisitionError({
        message: "Truncated tar archive.",
        source: "archive",
        kind: "extract-failed",
        remediation: "Download a complete tar/tar.gz archive and retry.",
      });
    if (type === 76) {
      longName = tar
        .subarray(start, start + size)
        .toString("utf8")
        .replace(/\0+$/u, "");
      continue;
    }
    if (type === 120 || type === 103) {
      longName = undefined;
      continue;
    }
    const fullName = longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    longName = undefined;
    const rel = safeEntryPath(fullName);
    if (rel === "") continue;
    const target = join(destDir, rel);
    if (type === 53 || fullName.endsWith("/")) {
      await mkdir(target, { recursive: true });
    } else if (type === 0 || type === 48) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(start, start + size));
    }
  }
};
