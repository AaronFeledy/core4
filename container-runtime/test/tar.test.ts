import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  END_OF_ARCHIVE,
  TAR_BLOCK_SIZE,
  UstarHeaderError,
  type UstarHeaderInput,
  encodeUstarHeader,
  endOfArchive,
  padToBlock,
} from "@lando/container-runtime/tar";

const file = { name: "payload", size: 5, mode: 0o644, typeflag: "0" } as const;
const decoder = new TextDecoder();

test("writes the POSIX layout when encoding a file", () => {
  // Given
  const input = file;
  // When
  const header = encodeUstarHeader(input);
  // Then
  expect(header.length).toBe(512);
  expect(decoder.decode(header.subarray(0, 100))).toBe(`payload${"\0".repeat(93)}`);
  expect(decoder.decode(header.subarray(100, 108))).toBe("0000644\0");
  expect(decoder.decode(header.subarray(108, 124))).toBe("0000000\0".repeat(2));
  expect(decoder.decode(header.subarray(124, 136))).toBe("00000000005\0");
  expect(decoder.decode(header.subarray(136, 148))).toBe("00000000000\0");
  expect(header[156]).toBe("0".charCodeAt(0));
  expect(decoder.decode(header.subarray(257, 263))).toBe("ustar\0");
  expect(decoder.decode(header.subarray(263, 265))).toBe("00");
});

test("writes link metadata when encoding a symlink", () => {
  // Given
  const input: UstarHeaderInput = { name: "link", size: 0, mode: 0o777, typeflag: "2", linkName: "payload" };
  // When
  const header = encodeUstarHeader(input);
  // Then
  expect(header[156]).toBe("2".charCodeAt(0));
  expect(decoder.decode(header.subarray(157, 257))).toBe(`payload${"\0".repeat(93)}`);
});

test("writes directory metadata when encoding a directory", () => {
  // Given
  const input: UstarHeaderInput = { name: "dir/", size: 0, mode: 0o755, typeflag: "5" };
  // When
  const header = encodeUstarHeader(input);
  // Then
  expect(header[156]).toBe("5".charCodeAt(0));
  expect(decoder.decode(header.subarray(100, 108))).toBe("0000755\0");
  expect(decoder.decode(header.subarray(124, 136))).toBe("00000000000\0");
});

test("preserves ownership and time when supplied", () => {
  // Given
  const input = { ...file, uid: 8, gid: 16, mtime: 64 };
  // When
  const header = encodeUstarHeader(input);
  // Then
  expect(decoder.decode(header.subarray(108, 116))).toBe("0000010\0");
  expect(decoder.decode(header.subarray(116, 124))).toBe("0000020\0");
  expect(decoder.decode(header.subarray(136, 148))).toBe("00000000100\0");
});

test("stores the space-filled checksum with POSIX termination when encoding", () => {
  // Given
  const input = file;
  // When
  const header = encodeUstarHeader(input);
  // Then
  const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
  expect(Number.parseInt(decoder.decode(header.subarray(148, 154)), 8)).toBe(sum);
  expect(header[154]).toBe(0);
  expect(header[155]).toBe(32);
});

test("stores a seven-digit NUL-terminated checksum when the legacy form is requested", () => {
  // Given
  const input = file;
  // When
  const header = encodeUstarHeader(input, { checksumForm: "nul-terminated" });
  // Then
  const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
  expect(Number.parseInt(decoder.decode(header.subarray(148, 155)), 8)).toBe(sum);
  expect(header[155]).toBe(0);
  expect(header.subarray(0, 148)).toEqual(encodeUstarHeader(input).subarray(0, 148));
});

test.each([
  { field: "name", value: "" },
  { field: "name", value: "a".repeat(101) },
  { field: "name", value: "界".repeat(34) },
  { field: "linkName", value: "" },
  { field: "linkName", value: "界".repeat(34) },
] as const)("rejects $field when its UTF-8 length is invalid ($value)", ({ field, value }) => {
  // Given
  const input = { ...file, [field]: value };
  // When
  const encode = () => encodeUstarHeader(input);
  // Then
  expect(encode).toThrow(UstarHeaderError);
  expect(encode).toThrow(expect.objectContaining({ field }));
});

test.each(["mode", "uid", "gid", "size", "mtime"] as const)(
  "rejects invalid octal values when encoding %s",
  (field) => {
    // Given
    const width = field === "size" || field === "mtime" ? 12 : 8;
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 8 ** (width - 1)]) {
      const input = { ...file, [field]: value };
      // When
      const encode = () => encodeUstarHeader(input);
      // Then
      expect(encode).toThrow(UstarHeaderError);
      expect(encode).toThrow(expect.objectContaining({ field }));
    }
  },
);

test("preserves full-width fields when inputs fit exactly", () => {
  // Given
  const input = { ...file, name: "a".repeat(100), linkName: "b".repeat(100), size: 8 ** 11 - 1 };
  // When
  const header = encodeUstarHeader(input);
  // Then
  expect(decoder.decode(header.subarray(0, 100))).toBe(input.name);
  expect(decoder.decode(header.subarray(157, 257))).toBe(input.linkName);
  expect(decoder.decode(header.subarray(124, 136))).toBe("77777777777\0");
});

test.each([
  [0, 0],
  [1, 511],
  [512, 0],
  [513, 511],
])("pads size %i with %i bytes", (size, expected) => {
  // Given / When
  const padding = padToBlock(size);
  // Then
  expect(padding).toBe(expected);
});

test("provides two zero blocks when constructing archive trailers", () => {
  // Given / When
  const trailer = endOfArchive();
  // Then
  expect(END_OF_ARCHIVE.length).toBe(1024);
  expect(END_OF_ARCHIVE.every((byte) => byte === 0)).toBe(true);
  expect(trailer).toEqual(END_OF_ARCHIVE);
  expect(trailer).not.toBe(END_OF_ARCHIVE);
  expect(trailer).not.toBe(endOfArchive());
});

test.skipIf(Bun.which("tar") === null)("lists the entry when tar reads a complete archive", async () => {
  // Given
  const root = await mkdtemp(join(process.cwd(), ".tmp-ustar-"));
  try {
    const path = join(root, "fixture.tar");
    const payload = new TextEncoder().encode("hello");
    const archive = new Uint8Array(TAR_BLOCK_SIZE + payload.length + padToBlock(payload.length) + 1024);
    archive.set(encodeUstarHeader(file));
    archive.set(payload, TAR_BLOCK_SIZE);
    archive.set(END_OF_ARCHIVE, archive.length - 1024);
    await Bun.write(path, archive);
    // When
    await using child = Bun.spawn(["tar", "-tvf", path], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    // Then
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("payload");
    console.info(`tar -tvf: ${stdout.trim()}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
