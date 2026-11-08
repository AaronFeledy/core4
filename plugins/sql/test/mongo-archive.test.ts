import { describe, expect, test } from "bun:test";

import { makeMongoArchiveTracker } from "../src/mongo-archive.ts";

// Captured in lando4-dev, MongoDB 7.0.45 / mongodump 100.19.1, using lando-base:
// exec db -- mongosh mongodb://lando:lando@localhost:27017/pr1602-mongo?authSource=admin
// alpha/beta: 700 {_id:i,value:"a"/"b".repeat(30)} docs each; createCollection("empty");
// createView("alpha_view","alpha",[{$match:{_id:{$gte:0}}}]). Then:
// exec db -- mongodump --uri=mongodb://lando:lando@localhost:27017/pr1602-mongo?authSource=admin
//   --archive --numParallelCollections=2 > concurrent.archive
// --collection=empty / --collection=alpha_view produced the single-namespace captures;
// URI database no_collections produced no-collections.archive. For multiblock.archive.gz,
// alpha/beta contain 160 {_id:i,value:name.repeat(30000)} docs each; mongodump uses --gzip.
// The mux buffers 16 MiB per namespace, so a real interleaved dump cannot be tiny
// uncompressed. Only the fixture loader decompresses; the tracker sees plaintext.
const fixtures = await Promise.all(
  [
    "concurrent.archive",
    "empty.archive",
    "view.archive",
    "no-collections.archive",
    "multiblock.archive.gz",
  ].map(async (name) => {
    const raw = await Bun.file(new URL(`./fixtures/mongo-archive/${name}`, import.meta.url)).bytes();
    return { name, bytes: name.endsWith(".gz") ? Bun.gunzipSync(raw) : raw };
  }),
);

type Field = readonly [string, string | boolean | number | null | ReadonlyArray<Field>];

const int32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setInt32(0, value, true);
  return [...bytes];
};

// A minimal BSON encoder for synthetic archives: strings, bools, doubles, null, and subdocuments.
const bson = (fields: ReadonlyArray<Field>): number[] => {
  const body: number[] = [];
  for (const [key, value] of fields) {
    const name = [...new TextEncoder().encode(key), 0];
    if (typeof value === "string") {
      const text = new TextEncoder().encode(value);
      body.push(2, ...name, ...int32(text.length + 1), ...text, 0);
    } else if (typeof value === "boolean") body.push(8, ...name, value ? 1 : 0);
    else if (typeof value === "number") {
      const double = new Uint8Array(8);
      new DataView(double.buffer).setFloat64(0, value, true);
      body.push(1, ...name, ...double);
    } else if (value === null) body.push(10, ...name);
    else body.push(3, ...name, ...bson(value));
  }
  return [...int32(body.length + 5), ...body, 0];
};

const archive = (input: {
  readonly prelude: ReadonlyArray<ReadonlyArray<Field>>;
  readonly blocks: ReadonlyArray<{
    readonly ns: readonly [string, string];
    readonly eof: boolean;
    readonly extra?: ReadonlyArray<Field>;
    readonly docs?: number;
  }>;
}): Uint8Array => {
  const terminator = [0xff, 0xff, 0xff, 0xff];
  const bytes = [0x6d, 0xe2, 0x99, 0x81, ...bson([["version", "0.1"]])];
  for (const entry of input.prelude) bytes.push(...bson(entry));
  bytes.push(...terminator);
  for (const block of input.blocks) {
    bytes.push(
      ...bson([["db", block.ns[0]], ["collection", block.ns[1]], ["EOF", block.eof], ...(block.extra ?? [])]),
    );
    for (let index = 0; index < (block.docs ?? 0); index++) bytes.push(...bson([["value", `doc-${index}`]]));
    bytes.push(...terminator);
  }
  return Uint8Array.from(bytes);
};

const check = (bytes: Uint8Array, chunkSize: number) => {
  const tracker = makeMongoArchiveTracker();
  let seed = 0x1602;
  let offset = 0;
  while (offset < bytes.length) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const length = chunkSize === -1 ? 1 + (seed % 8192) : chunkSize || bytes.length;
    tracker.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return tracker.complete();
};

// Walk BSON record lengths independently of namespace semantics. This finds real
// delimiters without mistaking ff ff ff ff inside document values for a boundary.
const boundaries = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ends: number[] = [];
  let offset = 4;
  while (offset < bytes.length) {
    const length = view.getInt32(offset, true);
    if (length === -1) {
      offset += 4;
      ends.push(offset);
    } else {
      if (length < 5) throw new RangeError(`Invalid fixture BSON at ${offset}`);
      offset += length;
    }
  }
  if (offset !== bytes.length) throw new RangeError("Fixture ends inside BSON");
  return ends;
};

describe("Mongo archive completeness", () => {
  for (const { name, bytes } of fixtures) {
    const ends = boundaries(bytes);
    test.each([0, 1, 3, -1])(
      `${name} is complete with chunk size %i (0=whole, -1=seeded random)`,
      (size) => {
        expect(check(bytes, size)).toBe(true);
      },
      60_000,
    );

    if (ends.length > 1) {
      test(`${name} rejects truncation at every nonfinal block terminator`, () => {
        for (const end of ends.slice(0, -1)) {
          expect(check(bytes.subarray(0, end), -1), `cut at ${end}`).toBe(false);
        }
      });
    }

    test(`${name} rejects partial magic, lengths, documents and terminators`, () => {
      const offsets = new Set([0, 1, 3, 4, 5, 7, bytes.length - 1, bytes.length - 3]);
      for (const end of ends) {
        offsets.add(end - 1);
        offsets.add(end - 5);
      }
      for (let i = 1; i < 32; i++) offsets.add(Math.floor((bytes.length * i) / 32));
      for (const end of offsets) {
        expect(check(bytes.subarray(0, end), 0), `cut at ${end}`).toBe(false);
      }
    });
  }

  test.each([0, 1, 4, -2, 16 * 1024 * 1024 + 65537, 0x7fffffff])(
    "rejects invalid BSON length %i",
    (length) => {
      const fixture = fixtures[0];
      if (!fixture) throw new RangeError("Missing concurrent fixture");
      const bytes = fixture.bytes.slice();
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setInt32(4, length, true);
      expect(check(bytes, 3)).toBe(false);
    },
  );

  test("rejects bad magic, header BSON, body BSON terminators and trailing junk", () => {
    const fixture = fixtures[0];
    if (!fixture) throw new RangeError("Missing concurrent fixture");
    for (const offset of [0, 107, 40565]) {
      const bytes = fixture.bytes.slice();
      bytes[offset] = 0x7f;
      expect(check(bytes, 3), `corruption at ${offset}`).toBe(false);
    }
    const tracker = makeMongoArchiveTracker();
    tracker.push(fixture.bytes);
    tracker.push(Uint8Array.of(0));
    expect(tracker.complete()).toBe(false);
  });

  test("rejects extra terminators and data after an EOF header", () => {
    const fixture = fixtures[2];
    if (!fixture) throw new RangeError("Missing view fixture");
    const extraTerminator = new Uint8Array(fixture.bytes.length + 4);
    extraTerminator.set(fixture.bytes);
    extraTerminator.fill(255, fixture.bytes.length);
    expect(check(extraTerminator, 1)).toBe(false);

    const bodyAfterEof = new Uint8Array(fixture.bytes.length + 5);
    bodyAfterEof.set(fixture.bytes.subarray(0, -4));
    bodyAfterEof.set([5, 0, 0, 0, 0, 255, 255, 255, 255], fixture.bytes.length - 4);
    expect(check(bodyAfterEof, 1)).toBe(false);
  });

  test("skips header fields a newer mongodump may add", () => {
    // Given a prelude and namespace headers carrying double, null, and embedded-document fields.
    const extra: ReadonlyArray<Field> = [
      ["ratio", 0.5],
      ["note", null],
      ["options", [["capped", false]]],
    ];
    const bytes = archive({
      prelude: [[["db", "app"], ["collection", "items"], ...extra]],
      blocks: [
        { ns: ["app", "items"], eof: false, extra, docs: 1 },
        { ns: ["app", "items"], eof: true, extra },
      ],
    });
    // Then the archive is complete in any chunking.
    expect(check(bytes, 0)).toBe(true);
    expect(check(bytes, 1)).toBe(true);
  });

  test("requires EOF for a namespace that opens without a prelude entry", () => {
    // Given an oplog-style block whose namespace the prelude never declared.
    const prelude: ReadonlyArray<ReadonlyArray<Field>> = [
      [
        ["db", "app"],
        ["collection", "items"],
      ],
    ];
    const items = [
      { ns: ["app", "items"], eof: false, docs: 2 },
      { ns: ["app", "items"], eof: true },
    ] as const;
    const oplogOpened = { ns: ["local", "oplog.rs"], eof: false, docs: 1 } as const;
    const oplogClosed = { ns: ["local", "oplog.rs"], eof: true } as const;
    // Then it passes once that namespace closes, and fails when it never does.
    expect(check(archive({ prelude, blocks: [...items, oplogOpened, oplogClosed] }), 3)).toBe(true);
    expect(check(archive({ prelude, blocks: [...items, oplogOpened] }), 3)).toBe(false);
  });

  test("can resume after complete() observes a partial archive", () => {
    const fixture = fixtures[0];
    if (!fixture) throw new RangeError("Missing concurrent fixture");
    const tracker = makeMongoArchiveTracker();
    tracker.push(fixture.bytes.subarray(0, 40640));
    expect(tracker.complete()).toBe(false);
    tracker.push(new Uint8Array());
    tracker.push(fixture.bytes.subarray(40640));
    expect(tracker.complete()).toBe(true);
  });
});
