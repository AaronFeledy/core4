import { expect, test } from "bun:test";
import { yamlRoundTripCorpus, yamlRoundTripRecord } from "@lando/sdk/test";
import { YamlEmitError, emitYamlDocument } from "@lando/sdk/yaml";

test("emitYamlDocument round-trips scalar, array, and record roots through Bun.YAML.parse", () => {
  // Given: every root shape and mixed nested values.
  const values: ReadonlyArray<unknown> = [
    yamlRoundTripRecord(),
    [...yamlRoundTripCorpus],
    { a: { b: [{ c: "foo:" }] } },
    {},
    [],
    "True",
    "",
    42,
    null,
    true,
    false,
    -1.5,
    1e30,
    { text: "[redacted]", count: 3, enabled: false, absent: null, empty: {}, items: [[], {}, ["True"]] },
    Object.fromEntries(yamlRoundTripCorpus.map((key) => [key, "value"])),
  ];
  for (const value of values) {
    // When: a whole document is emitted.
    const document = emitYamlDocument(value);
    // Then: its root round-trips and it has exactly one terminal newline.
    expect(Bun.YAML.parse(document)).toEqual(value);
    expect(document.endsWith("\n")).toBe(true);
    expect(document.endsWith("\n\n")).toBe(false);
  }
});

test("emitYamlDocument aligns compact array records with two-space indentation", () => {
  // Given: a record item with scalar and nested continuation fields.
  const value = { items: [{ name: "db", nested: { ports: ["8080:80"] }, empty: [] }] };
  // When: emitting the document.
  const document = emitYamlDocument(value);
  // Then: the first key shares the dash line and continuations align.
  expect(document).toBe(
    "items:\n  - name: db\n    nested:\n      ports:\n        - 8080:80\n    empty: []\n",
  );
});

test("emitYamlDocument rejects non-JSON values", () => {
  // Given: unsupported roots, descendants, sparse arrays, and cycles.
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cyclicArray: unknown[] = [];
  cyclicArray.push(cyclicArray);
  class Custom {}
  const values = [
    undefined,
    () => 1,
    Symbol("x"),
    1n,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    new Date(),
    new Map(),
    /x/u,
    new Custom(),
    cyclic,
    cyclicArray,
    { nested: undefined },
    [undefined],
    Array(1),
  ];
  // When / Then: every unsupported value fails through the public error class.
  for (const value of values) expect(() => emitYamlDocument(value)).toThrow(YamlEmitError);
});

test("emitYamlDocument permits shared acyclic objects and null-prototype records", () => {
  // Given: the same object in two branches, not an ancestor cycle.
  const shared = { value: "foo:" };
  const record: Record<string, unknown> = Object.create(null);
  record.first = shared;
  record.second = shared;
  // When: emitting both branches.
  const document = emitYamlDocument(record);
  // Then: each branch is represented independently.
  expect(Bun.YAML.parse(document)).toEqual({ first: shared, second: shared });
});

test("yamlRoundTripRecord maps stable corpus indices into fresh records", () => {
  // Given: the public corpus.
  // When: constructing a record for an emitter's round-trip test.
  const record = yamlRoundTripRecord();
  // Then: each stable key has its corresponding value, without shared mutable records.
  expect(Object.keys(record)).toEqual(yamlRoundTripCorpus.map((_, index) => `v${index}`));
  expect(Object.values(record)).toEqual([...yamlRoundTripCorpus]);
  expect(yamlRoundTripRecord()).not.toBe(record);
});
