import { describe, expect, test } from "bun:test";
import { ArchiveFormatError } from "@lando/sdk/errors";
import { VolumeArchiveGate } from "../src/volume-archive-gate.ts";
import { VolumeArchiveWalker } from "../src/volume-archive-walker.ts";

const encoder = new TextEncoder();

interface Member {
  readonly name: string;
  readonly data?: string | Uint8Array;
  readonly typeflag?: string;
  readonly linkname?: string;
  readonly mode?: number;
  readonly size?: number;
  /** Overrides that produce a deliberately malformed header. */
  readonly rawChecksum?: string;
  readonly rawMagic?: string;
}

const field = (header: Uint8Array, offset: number, length: number, value: string): void => {
  header.set(encoder.encode(value).subarray(0, length), offset);
};

const octal = (value: number, width: number): string => `${value.toString(8).padStart(width - 1, "0")}\0`;

const headerFor = (member: Member): Uint8Array => {
  const payload =
    member.data === undefined
      ? new Uint8Array()
      : typeof member.data === "string"
        ? encoder.encode(member.data)
        : member.data;
  const header = new Uint8Array(512);
  field(header, 0, 100, member.name);
  field(header, 100, 8, octal(member.mode ?? 0o644, 8));
  field(header, 108, 8, octal(0, 8));
  field(header, 116, 8, octal(0, 8));
  field(header, 124, 12, octal(member.size ?? payload.byteLength, 12));
  field(header, 136, 12, octal(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = encoder.encode(member.typeflag ?? "0")[0] ?? 0x30;
  field(header, 157, 100, member.linkname ?? "");
  field(header, 257, 6, member.rawMagic ?? "ustar\0");
  field(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  field(header, 148, 8, member.rawChecksum ?? `${octal(checksum, 7).trimEnd()}\0 `);
  return header;
};

const archiveOf = (members: ReadonlyArray<Member>): Uint8Array => {
  const blocks: Uint8Array[] = [];
  for (const member of members) {
    const header = headerFor(member);
    blocks.push(header);
    const payload =
      member.data === undefined
        ? new Uint8Array()
        : typeof member.data === "string"
          ? encoder.encode(member.data)
          : member.data;
    if (payload.byteLength > 0) {
      const padded = new Uint8Array(Math.ceil(payload.byteLength / 512) * 512);
      padded.set(payload);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
};

const reject = (archive: Uint8Array): unknown => {
  const gate = new VolumeArchiveGate("fixture.tar");
  try {
    gate.push(archive);
    gate.finish();
  } catch (cause) {
    return cause;
  }
  throw new Error("Expected the gate to reject the archive");
};

const accepts = (archive: Uint8Array): void => {
  const gate = new VolumeArchiveGate("fixture.tar");
  const forwarded = [gate.push(archive), gate.finish()];
  const total = forwarded.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  expect(total).toBe(archive.byteLength);
};

describe("volume archive gate", () => {
  test("forwards a complete safe archive and withholds bytes until validation", () => {
    const archive = archiveOf([
      { name: "./", typeflag: "5" },
      { name: "./dir/", typeflag: "5" },
      { name: "./dir/file", data: "payload" },
    ]);
    const gate = new VolumeArchiveGate("fixture.tar");
    const first = gate.push(archive.subarray(0, 100));
    expect(first.byteLength).toBe(0);
    const rest = gate.push(archive.subarray(100));
    const tail = gate.finish();
    expect(first.byteLength + rest.byteLength + tail.byteLength).toBe(archive.byteLength);
  });

  const paxRecord = (key: string, value: string): string => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
  };

  describe("volume archive gate", () => {
    test("accepts base-256 sizes and GNU/pax long names", () => {
      const longName = `${"a".repeat(120)}.txt`;
      accepts(
        archiveOf([
          { name: "./", typeflag: "5" },
          { name: "PaxHeader", typeflag: "x", data: paxRecord("path", longName) },
          { name: "truncated-name", data: "pax" },
        ]),
      );
      accepts(archiveOf([{ name: "LongLink", typeflag: "L", data: longName }, { name: "short" }]));
    });
  });

  test.each([
    ["absolute member path", archiveOf([{ name: "/etc/passwd" }])],
    ["parent traversal", archiveOf([{ name: "../escape" }])],
    [
      "NUL-bearing pax name",
      archiveOf([
        { name: "PaxHeader", typeflag: "x", data: paxRecord("path", "safe\0alias") },
        { name: "short" },
      ]),
    ],
    [
      "global pax linkpath override",
      archiveOf([
        { name: "safe", data: "payload" },
        { name: "GlobalHead", typeflag: "g", data: paxRecord("linkpath", "safe") },
        { name: "alias", typeflag: "1", linkname: "../.lando-volume-witness.json" },
      ]),
    ],
    [
      "pax header followed only by end blocks",
      archiveOf([{ name: "PaxHeader", typeflag: "x", data: paxRecord("path", "x") }]),
    ],
    ["reserved witness name", archiveOf([{ name: ".lando-volume-witness.json" }])],
    ["reserved import staging name", archiveOf([{ name: ".lando-import-abc" }])],
    ["reserved replaced name", archiveOf([{ name: ".lando-replaced-abc" }])],
    ["reserved installing marker", archiveOf([{ name: ".lando-installing-abc" }])],
    [
      "symlink parent traversal",
      archiveOf([{ name: "link", typeflag: "2", linkname: "target" }, { name: "link/child" }]),
    ],
    [
      "hardlink to a reserved live-volume entry",
      archiveOf([{ name: "alias", typeflag: "1", linkname: "../.lando-volume-witness.json" }]),
    ],
    ["external hardlink", archiveOf([{ name: "alias", typeflag: "1", linkname: "missing" }])],
    ["bad checksum", archiveOf([{ name: "file", rawChecksum: "0000000\0 " }])],
    ["bad magic", archiveOf([{ name: "file", rawMagic: "xxxxx\0" }])],
    ["dangling extended header", archiveOf([{ name: "PaxHeader", typeflag: "x", data: "5 path=x\n" }])],
    ["empty input", new Uint8Array()],
    ["truncated member", archiveOf([{ name: "file", data: "payload" }]).subarray(0, 700)],
  ])("rejects %s before forwarding it", (_label, archive) => {
    expect(reject(archive)).toBeInstanceOf(ArchiveFormatError);
  });
});

describe("volume archive gate trailing bytes", () => {
  test("drops bytes after the end blocks so a large suffix stays bounded", () => {
    const archive = archiveOf([{ name: "file", data: "payload" }]);
    const suffix = new Uint8Array(4 * 1024 * 1024);
    suffix.fill(0x41);
    const gate = new VolumeArchiveGate("fixture.tar");
    const forwarded = gate.push(archive);
    expect(forwarded.byteLength).toBe(archive.byteLength);
    expect(gate.bufferedBytes).toBe(0);
    for (let offset = 0; offset < suffix.byteLength; offset += 64 * 1024) {
      expect(gate.push(suffix.subarray(offset, offset + 64 * 1024)).byteLength).toBe(0);
      expect(gate.bufferedBytes).toBe(0);
    }
    expect(gate.finish().byteLength).toBe(0);
  });

  test("ends with a synthetic end block and forwards no source byte after the first", () => {
    const single = archiveOf([{ name: "file", data: "payload" }]).subarray(0, 1536);
    const extra = new Uint8Array([...single, ...new Uint8Array(4096)]);
    const gate = new VolumeArchiveGate("fixture.tar");
    const forwarded = new Uint8Array([...gate.push(extra), ...gate.finish()]);
    expect(forwarded.byteLength).toBe(2048);
    expect(forwarded.subarray(1536).every((byte) => byte === 0)).toBe(true);
    expect(gate.bufferedBytes).toBe(0);
  });

  test("never forwards a member hidden after a single end block", () => {
    const valid = archiveOf([{ name: "file", data: "payload" }]).subarray(0, 1536);
    const hidden = archiveOf([
      { name: "alias", typeflag: "1", linkname: "../.lando-volume-witness.json" },
    ]).subarray(0, 512);
    const archive = new Uint8Array([...valid, ...hidden, ...new Uint8Array(1024)]);
    const gate = new VolumeArchiveGate("fixture.tar");
    const forwarded = new Uint8Array([...gate.push(archive), ...gate.finish()]);
    expect(Array.from(forwarded.subarray(0, 1536))).toEqual(Array.from(valid));
    expect(forwarded.subarray(1536).every((byte) => byte === 0)).toBe(true);
  });
});

describe("volume archive walker", () => {
  test("reports validated bytes only for complete header blocks", () => {
    const walker = new VolumeArchiveWalker("fixture.tar");
    const archive = archiveOf([{ name: "file", data: "payload" }]);
    walker.push(archive.subarray(0, 100));
    expect(walker.validatedBytes).toBe(0);
    walker.push(archive.subarray(100, 512));
    expect(walker.validatedBytes).toBe(512);
  });
});
