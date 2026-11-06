import { describe, expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Result } from "effect";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { abi6Bytes, app, encodedInput, entry, input, without } from "./fixtures/command-index-codec.ts";

const withFlag = (patch: object) => ({
  ...encodedInput,
  flags: encodedInput.flags.map((flag, index) => (index === 0 ? { ...flag, ...patch } : flag)),
});
const withArg = (patch: object) => ({
  ...encodedInput,
  args: encodedInput.args.map((arg, index) => (index === 0 ? { ...arg, ...patch } : arg)),
});

for (const [magic, payload, decode] of [["LCAC", app, decodeAppCommandIndex]] as const) {
  describe(`${magic} current-ABI validation`, () => {
    test.each([null, [], new Map(), new Set()].map((value) => ({ value })))(
      "rejects non-record payloads %#",
      ({ value }) => {
        // Given / When / Then
        expect(decode(abi6Bytes(magic, value))).toBeNull();
      },
    );
    test.each([1n, 2n, 3n, 4n, 5n])("rejects old header %s with a current body", (version) => {
      // Given
      const bytes = abi6Bytes(magic, payload);
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, version, true);
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test("rejects a truncated v8 body under the current header", () => {
      // Given
      const bytes = abi6Bytes(magic, payload).subarray(0, 15);
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test.each(["schemaVersion", "landoVersion", "generatedAtMs", "entries"])(
      "rejects missing required field %s",
      (key) => {
        // Given
        const bytes = abi6Bytes(magic, without(payload, key));
        // When / Then
        expect(decode(bytes)).toBeNull();
      },
    );
    test.each([
      { schemaVersion: 5 },
      { landoVersion: null },
      { generatedAtMs: Number.NaN },
      { generatedAtMs: Number.POSITIVE_INFINITY },
      { entries: null },
      { entries: {} },
      { entries: [null] },
      { entries: new Array(1) },
      ...["id", "summary", "hidden"].map((key) => ({ entries: [without(entry, key)] })),
      ...[{ id: 1 }, { summary: false }, { hidden: "false" }, { service: null }, { source: "shell" }].map(
        (patch) => ({ entries: [{ ...entry, ...patch }] }),
      ),
      ...[false, "true", null, 1].map((disabled) => ({ entries: [{ ...entry, hidden: true, disabled }] })),
      { entries: [{ ...entry, hidden: false, disabled: true }] },
    ])("rejects malformed common fields %#", (patch) => {
      // Given
      const bytes = abi6Bytes(magic, { ...payload, ...patch });
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test.each(
      [
        null,
        [],
        ...["flags", "args", "acceptsArguments", "revision"].map((key) => without(encodedInput, key)),
        ...[
          { flags: null },
          { flags: {} },
          { flags: [null] },
          { flags: new Array(1) },
          { args: null },
          { args: {} },
          { args: [null] },
          { args: new Array(1) },
          { acceptsArguments: "true" },
          { revision: 42 },
          { revision: null },
        ].map((patch) => ({ ...encodedInput, ...patch })),
        ...["name", "boolean", "required", "sensitive"].map((key) => ({
          ...encodedInput,
          flags: input.flags.map((flag) => without(flag, key)),
        })),
        ...["name", "order", "required", "sensitive"].map((key) => ({
          ...encodedInput,
          args: input.args.map((arg) => without(arg, key)),
        })),
        ...[
          { name: 3 },
          { alias: null },
          { boolean: "true" },
          { required: 0 },
          { sensitive: null },
          { description: [] },
          { choices: "dev" },
          { choices: [1] },
          { choices: new Array(1) },
          { default: null },
          { default: 1 },
          { default: true },
          { boolean: true, default: "dev" },
        ].map(withFlag),
        ...[
          { name: null },
          { order: "0" },
          { order: Number.NaN },
          { order: Number.POSITIVE_INFINITY },
          { order: -1 },
          { order: 0.5 },
          { required: "true" },
          { sensitive: 0 },
          { description: null },
          { choices: [null] },
          { default: false },
          { default: null },
        ].map(withArg),
      ].map((malformedInput) => ({ malformedInput })),
    )("rejects malformed canonical input %#", ({ malformedInput }) => {
      // Given
      const bytes = abi6Bytes(magic, { ...payload, entries: [{ ...entry, input: malformedInput }] });
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test("roundtrips SDK-encoded declarations", () => {
      // Given
      const payloadWithEncodedInput = { ...payload, entries: [{ ...entry, input: encodedInput }] };
      // When
      const decoded = decode(abi6Bytes(magic, payloadWithEncodedInput));
      // Then
      expect(decoded).toEqual({ ...payload, entries: [entry] });
    });
    test("roundtrips disabled metadata separately from internal visibility", () => {
      // Given
      const expected = {
        ...payload,
        entries: [
          { ...entry, hidden: true },
          { ...entry, hidden: true, disabled: true as const },
        ],
      };
      // When / Then
      expect(decode(abi6Bytes(magic, expected))).toEqual(expected);
    });
    test.each([true, false])("roundtrips empty input with argument policy %s", (acceptsArguments) => {
      // Given
      const emptyInput = Result.getOrThrowWith(
        normalizeToolingInput("empty", acceptsArguments ? {} : { arguments: false }),
        (error) => error,
      );
      const expected = { ...payload, entries: [{ ...entry, input: emptyInput }] };
      // When / Then
      expect(decode(abi6Bytes(magic, expected))).toEqual(expected);
    });
  });
}

test("roundtrips complete app metadata through the typed encoder", () => {
  // Given / When
  const decoded = decodeAppCommandIndex(encodeAppCommandIndex(app));
  // Then
  expect(decoded).toEqual(app);
});

test.each([
  ...["appName", "sourceFile", "sourceMtimeMs", "sourceSize"].map((key) => without(app, key)),
  ...[
    { appName: null },
    { sourceFile: 2 },
    { sourceMtimeMs: Number.POSITIVE_INFINITY },
    { sourceSize: Number.NaN },
    { sourceContentHash: false },
    { toolingFingerprint: {} },
    { entriesFingerprint: [] },
    { sourceLocalIncludePaths: [null] },
    { sourceLocalIncludePaths: {} },
    { sourceReferencedFiles: [null] },
    { sourceReferencedFiles: {} },
    { sourceScripts: [null] },
    { sourceScripts: {} },
    { versionConstraints: [null] },
    { versionConstraints: {} },
    { aliasPolicy: null },
    { aliasPolicy: {} },
    ...[
      { enabled: "true" },
      { disabled: null },
      { disabled: [0] },
      { custom: null },
      { custom: [] },
      { custom: { ship: 0 } },
    ].map((patch) => ({ aliasPolicy: { ...app.aliasPolicy, ...patch } })),
    ...["enabled", "disabled", "custom"].map((key) => ({ aliasPolicy: without(app.aliasPolicy, key) })),
    ...["absolutePath", "size", "mtimeMs", "sha256"].map((key) => ({
      sourceReferencedFiles: app.sourceReferencedFiles.map((file) => without(file, key)),
    })),
    ...[
      { absolutePath: 1 },
      { size: Number.NaN },
      { mtimeMs: Number.POSITIVE_INFINITY },
      { sha256: false },
    ].map((patch) => ({
      sourceReferencedFiles: app.sourceReferencedFiles.map((file) => ({ ...file, ...patch })),
    })),
    ...[{ relativePath: 1 }, { sha256: null }].map((patch) => ({
      sourceScripts: app.sourceScripts.map((script) => ({ ...script, ...patch })),
    })),
    ...["relativePath", "sha256"].map((key) => ({
      sourceScripts: app.sourceScripts.map((script) => without(script, key)),
    })),
    ...[{ range: null }, { source: false }, { layer: "other" }, { order: 6 }, { order: 0 }].map((patch) => ({
      versionConstraints: app.versionConstraints.map((constraint) => ({ ...constraint, ...patch })),
    })),
    ...["range", "source", "layer", "order"].map((key) => ({
      versionConstraints: app.versionConstraints.map((constraint) => without(constraint, key)),
    })),
  ].map((patch) => ({ ...app, ...patch })),
])("rejects malformed app metadata %#", (payload) => {
  // Given
  const bytes = abi6Bytes("LCAC", payload);
  // When / Then
  expect(decodeAppCommandIndex(bytes)).toBeNull();
});
