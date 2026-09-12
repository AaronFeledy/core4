import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const cases = [
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
