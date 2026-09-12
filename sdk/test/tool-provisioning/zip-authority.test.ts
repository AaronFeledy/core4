import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { ToolExtractError } from "@lando/sdk/errors";
import { provisionTool } from "@lando/sdk/tool-provisioning";
import { Effect, Either } from "effect";
import { makeFakeDownloader, makeZip, sha256Hex } from "./_fixtures.ts";

const regular = { name: "nested/tool", bytes: Buffer.from("real executable") };
const first = { name: "tool", bytes: Buffer.from("not an executable"), mode: 0 };

const fixture = (kind: string): Uint8Array => {
  const bytes = Buffer.from(makeZip([first, regular]));
  const end = bytes.length - 22;
  const central = bytes.readUInt32LE(end + 16);
  switch (kind) {
    case "missing EOCD":
      return bytes.subarray(0, end);
    case "orphan local record": {
      const recordSize = 46 + first.name.length;
      const orphan = Buffer.concat([bytes.subarray(0, central), bytes.subarray(central + recordSize)]);
      const eocd = orphan.length - 22;
      orphan.writeUInt16LE(1, eocd + 8);
      orphan.writeUInt16LE(1, eocd + 10);
      orphan.writeUInt32LE(bytes.readUInt32LE(end + 12) - recordSize, eocd + 12);
      return orphan;
    }
    case "central name mismatch":
      bytes[central + 46] = 0x78;
      return bytes;
    case "truncated central directory":
      bytes.writeUInt32LE(1, end + 12);
      return bytes;
    case "wrong entry count":
      bytes.writeUInt16LE(3, end + 8);
      bytes.writeUInt16LE(3, end + 10);
      return bytes;
    default:
      throw new Error(`Unknown fixture: ${kind}`);
  }
};

const directoryZip = (mode: number, suffix: string, sibling: boolean): Uint8Array => {
  const bytes = Buffer.from(
    makeZip([{ ...first, name: `tool${suffix}`, mode }, ...(sibling ? [regular] : [])]),
  );
  const central = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt32LE(((mode << 16) | 0x10) >>> 0, central + 38);
  return bytes;
};

const payloadZip = (compression: number, declaredSize: number, descriptorSize = 0): Buffer => {
  const payload = compression === 8 ? deflateRawSync(regular.bytes) : regular.bytes;
  const bytes = Buffer.from(makeZip([{ name: "tool", bytes: payload }]));
  const central = bytes.readUInt32LE(bytes.length - 6);
  bytes.writeUInt16LE(compression, 8);
  bytes.writeUInt16LE(compression, central + 10);
  bytes.writeUInt32LE(declaredSize, 22);
  bytes.writeUInt32LE(declaredSize, central + 24);
  if (descriptorSize === 0) return bytes;
  bytes.writeUInt16LE(8, 6);
  bytes.writeUInt16LE(8, central + 8);
  bytes.writeUInt32LE(0, 18);
  bytes.writeUInt32LE(0, 22);
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50);
  descriptor.writeUInt32LE(bytes.readUInt32LE(central + 16), 4);
  descriptor.writeUInt32LE(payload.length, 8);
  descriptor.writeUInt32LE(declaredSize, 12);
  const result = Buffer.concat([
    bytes.subarray(0, central),
    descriptor.subarray(descriptorSize === 12 ? 4 : 0, descriptorSize === 12 ? 16 : descriptorSize),
    bytes.subarray(central),
  ]);
  result.writeUInt32LE(central + descriptorSize, result.length - 6);
  return result;
};

const boundsCases = [
  ...[0, 1, regular.bytes.length - 1, regular.bytes.length + 1].flatMap((size) =>
    [0, 8].map((method) => ({
      name: `method ${method} wrong declared size ${size}`,
      bytes: payloadZip(method, size),
      accepts: false,
    })),
  ),
  ...[0, 8].flatMap((method) =>
    [0, 12, 16].map((descriptor) => ({
      name: `method ${method} exact size with descriptor ${descriptor}`,
      bytes: payloadZip(method, regular.bytes.length, descriptor),
      accepts: true,
    })),
  ),
  ...[1, 4, 8, 15].map((size) => ({
    name: `descriptor truncated to ${size} bytes before central directory`,
    bytes: payloadZip(0, regular.bytes.length, size),
    accepts: false,
  })),
  ...[
    "empty stored forgery",
    "empty stored",
    "payload overlap",
    "extra overlap",
    "filename overflow",
    "size overflow",
    "truncated deflate",
    "invalid deflate",
    "missing descriptor",
    "wrong descriptor size",
  ].map((name) => {
    const bytes = name.startsWith("empty stored")
      ? Buffer.from(makeZip([{ name: "tool", bytes: Buffer.alloc(0) }]))
      : payloadZip(
          name.endsWith("deflate") ? 8 : 0,
          regular.bytes.length,
          name === "wrong descriptor size" ? 16 : 0,
        );
    const central = bytes.readUInt32LE(bytes.length - 6);
    switch (name) {
      case "empty stored forgery":
        bytes.writeUInt32LE(1, 22);
        bytes.writeUInt32LE(1, central + 24);
        break;
      case "payload overlap":
      case "size overflow": {
        const size = name === "size overflow" ? 0xffffffff : regular.bytes.length + 1;
        for (const offset of [18, 22, central + 20, central + 24]) bytes.writeUInt32LE(size, offset);
        break;
      }
      case "extra overlap":
        bytes.writeUInt16LE(regular.bytes.length + 1, 28);
        break;
      case "filename overflow":
        bytes.writeUInt16LE(0xffff, 26);
        break;
      case "truncated deflate":
        bytes.writeUInt32LE(1, 18);
        bytes.writeUInt32LE(1, central + 20);
        break;
      case "invalid deflate":
        bytes[34] = 0xff;
        break;
      case "missing descriptor":
        bytes.writeUInt16LE(8, 6);
        bytes.writeUInt16LE(8, central + 8);
        break;
      case "wrong descriptor size":
        bytes.writeUInt32LE(1, central - 4);
        break;
    }
    return { name, bytes, accepts: false };
  }),
];

const cases = [
  ...boundsCases,
  ...[
    "missing EOCD",
    "orphan local record",
    "central name mismatch",
    "truncated central directory",
    "wrong entry count",
  ].map((name) => ({ name, bytes: fixture(name), accepts: false })),
  ...[0, 0o100644, 0o040755].flatMap((mode) =>
    [false, true].map((accepts) => ({
      name: `DOS directory mode ${mode.toString(8)} with sibling ${accepts}`,
      bytes: directoryZip(mode, "", accepts),
      accepts,
    })),
  ),
  {
    name: "directory filename overrides regular mode",
    bytes: directoryZip(0o100644, "/", true),
    accepts: true,
  },
];

test.each(cases)("ZIP authority: $name", async ({ bytes, accepts }) => {
  // Given: an existing installation and a privately constructed hostile ZIP.
  const root = await mkdtemp(join(tmpdir(), "lando-zip-authority-"));
  const binDir = join(root, "bin");
  const previous = {
    tool: "existing executable",
    "tool.sha256": "existing fingerprint",
    ".tool.version": "existing version",
  };
  const dl = makeFakeDownloader();
  const url = "https://example.test/tool.zip";
  dl.serve(url, bytes);
  try {
    await mkdir(binDir);
    for (const [name, content] of Object.entries(previous)) await writeFile(join(binDir, name), content);
    // When: forced provisioning attempts selection before any publication.
    const result = await Effect.runPromise(
      Effect.either(
        Effect.scoped(
          provisionTool({
            manifest: {
              schemaVersion: 1,
              toolVersion: "new",
              artifacts: {
                cli: { url, sha256: sha256Hex(bytes), archive: "zip", member: "tool", installName: "tool" },
              },
            },
            key: "cli",
            toolId: "tool",
            binDir,
            toolDownloadsDir: join(root, "downloads"),
            force: true,
          }),
        ).pipe(Effect.provide(dl.layer)),
      ),
    );
    // Then: only authoritative regular siblings install; rejected inputs preserve the entire install.
    if (accepts) {
      expect(Either.isRight(result)).toBe(true);
      expect(await readFile(join(binDir, "tool"))).toEqual(regular.bytes);
    } else {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(ToolExtractError);
      for (const [name, content] of Object.entries(previous))
        expect(await readFile(join(binDir, name), "utf8")).toBe(content);
    }
    expect((await readdir(binDir)).sort()).toEqual(Object.keys(previous).sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
