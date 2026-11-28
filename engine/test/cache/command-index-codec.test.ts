import { describe, expect, test } from "bun:test";
import { normalizeToolingInput } from "@lando/landofile/tooling-input-normalize";
import { Result } from "effect";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "../../src/cache/command-index.ts";
import { app, currentAbiBytes, encodedInput, entry, input, without } from "./fixtures/command-index-codec.ts";

const withFlag = (patch: object) => ({
  ...encodedInput,
  flags: encodedInput.flags.map((flag, index) => (index === 0 ? { ...flag, ...patch } : flag)),
});
const withArg = (patch: object) => ({
  ...encodedInput,
  args: encodedInput.args.map((arg, index) => (index === 0 ? { ...arg, ...patch } : arg)),
});

const unavailable = {
  id: "app:broken",
  summary: "Unavailable script",
  _tag: "Unavailable",
  visibility: "public",
  sourceKind: "bun-script",
  diagnostic: {
    _tag: "BunShellScriptFrontMatterError",
    message: "Missing front matter",
    remediation: "Run lando app:config:lint.",
  },
} as const;
const disabled = {
  _tag: "Disabled",
  id: "app:retired",
  summary: "Retired",
  sourceKind: "tooling",
  visibility: "public",
  source: { path: "/app/.lando.local.yml", task: "retired" },
} as const;
test.each([
  ...["source", "diagnostic", "hidden", "disabled", "loadError", "extra"].map((key) => ({ row: entry, key })),
  ...["input", "service", "wrapper", "runs", "diagnostic", "hidden", "disabled", "loadError", "extra"].map(
    (key) => ({ row: disabled, key }),
  ),
  ...["input", "service", "wrapper", "runs", "source", "hidden", "disabled", "loadError", "extra"].map(
    (key) => ({ row: unavailable, key }),
  ),
])("rejects forbidden $key on availability arm %#", ({ row, key }) => {
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [{ ...row, [key]: undefined }] })),
  ).toBeNull();
});
test.each(["source", "_tag", "visibility", "sourceKind"])("requires disabled %s", (key) => {
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [without(disabled, key)] })),
  ).toBeNull();
});
const unavailableWithIssues = (issues: readonly object[]) => ({
  ...unavailable,
  diagnostic: {
    _tag: "BunShellScriptFrontMatterError",
    message: "Invalid env declarations",
    remediation: "Correct the script's env declarations.",
    issues,
    omittedIssueCount: 0,
  },
});

test("round-trips a bounded script diagnostic with located issues", () => {
  // Given one issue located at the script's front-matter key
  const issue = {
    reason: "other-scope",
    path: ["env", "SITE"],
    message: "env.SITE reads {{ env.* }}, which a script env value cannot.",
    source: { layer: "script", file: "/app/.lando/scripts/check.bun.sh", path: ["env", "SITE"] },
  };
  // When / Then the decoder retains it
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [unavailableWithIssues([issue])] }))
      ?.entries,
  ).toMatchObject([{ diagnostic: { issues: [issue], omittedIssueCount: 0 } }]);
  // And rejects more than the bounded issue count
  expect(
    decodeAppCommandIndex(
      currentAbiBytes("LCAC", {
        ...app,
        entries: [unavailableWithIssues(Array.from({ length: 9 }, () => issue))],
      }),
    ),
  ).toBeNull();
});

test("accepts readsRouteFacts only on a Ready bun-script entry", () => {
  // Given one script entry that reads route facts and one tooling entry carrying the same flag
  const script = {
    id: "app:smoke",
    summary: "Smoke",
    _tag: "Ready",
    sourceKind: "bun-script",
    visibility: "public",
    input,
    readsRouteFacts: true,
  };
  const tooling = { ...entry, readsRouteFacts: true };
  // Then
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [script] }))?.entries,
  ).toMatchObject([{ id: "app:smoke", readsRouteFacts: true }]);
  expect(decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [tooling] }))).toBeNull();
});

test("rejects cyclic unallowlisted diagnostic content without throwing", () => {
  const cause: { cause?: object } = {};
  cause.cause = cause;
  expect(
    decodeAppCommandIndex(
      currentAbiBytes("LCAC", {
        ...app,
        entries: [{ ...unavailable, diagnostic: { ...unavailable.diagnostic, cause } }],
      }),
    ),
  ).toBeNull();
});
test.each(["bun-script", "tooling"] as const)(
  "roundtrips unavailable source %s without executable metadata",
  (source) => {
    const row = { ...unavailable, sourceKind: source };
    expect(
      decodeAppCommandIndex(
        currentAbiBytes("LCAC", {
          ...app,
          entries: [row],
          sourceScripts: [{ relativePath: "broken.bun.sh", invalid: "digest" }],
        }),
      )?.entries,
    ).toEqual([row]);
  },
);
test.each([
  { input: encodedInput },
  { wrapper: true },
  { disabled: true, hidden: true },
  { service: "web" },
  { runs: { kind: "script", path: ".lando/scripts/test.bun.sh" } },
  { diagnostic: null },
  { diagnostic: { _tag: "Error", message: "x".repeat(1025) } },
  { diagnostic: { _tag: "Error", message: "broken", remediation: "x".repeat(1025) } },
])("rejects an executable or malformed unavailable script %#", (patch) => {
  expect(
    decodeAppCommandIndex(currentAbiBytes("LCAC", { ...app, entries: [{ ...unavailable, ...patch }] })),
  ).toBeNull();
});

test("rejects a disabled unavailable tooling row", () => {
  const toolingUnavailable = { ...unavailable, sourceKind: "tooling" };
  expect(
    decodeAppCommandIndex(
      currentAbiBytes("LCAC", {
        ...app,
        entries: [{ ...toolingUnavailable, disabled: true, hidden: true }],
      }),
    ),
  ).toBeNull();
});

for (const [magic, payload, decode] of [["LCAC", app, decodeAppCommandIndex]] as const) {
  describe(`${magic} current-ABI validation`, () => {
    test.each([null, [], new Map(), new Set()].map((value) => ({ value })))(
      "rejects non-record payloads %#",
      ({ value }) => {
        // Given / When / Then
        expect(decode(currentAbiBytes(magic, value))).toBeNull();
      },
    );
    test.each([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n])(
      "rejects old header %s with a current body",
      (version) => {
        // Given
        const bytes = currentAbiBytes(magic, payload);
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setBigUint64(4, version, true);
        // When / Then
        expect(decode(bytes)).toBeNull();
      },
    );
    test("rejects a truncated v8 body under the current header", () => {
      // Given
      const bytes = currentAbiBytes(magic, payload).subarray(0, 15);
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test.each(["schemaVersion", "landoVersion", "generatedAtMs", "entries", "sourceEnvironment"])(
      "rejects missing required field %s",
      (key) => {
        // Given
        const bytes = currentAbiBytes(magic, without(payload, key));
        // When / Then
        expect(decode(bytes)).toBeNull();
      },
    );
    test.each([
      { schemaVersion: 5 },
      { landoVersion: null },
      { sourceEnvironment: null },
      { sourceEnvironment: "" },
      { sourceEnvironment: { _tag: "Complete", hash: "not-a-digest" } },
      { sourceEnvironment: { _tag: "Complete", hash: "" } },
      { sourceEnvironment: { _tag: "Complete" } },
      { sourceEnvironment: { _tag: "Names", names: ["B", "A"], hash: "a".repeat(64) } },
      { sourceEnvironment: { _tag: "Names", names: ["A", "A"], hash: "a".repeat(64) } },
      { sourceEnvironment: { _tag: "Names", names: ["A"], hash: "not-a-digest" } },
      { sourceEnvironment: { _tag: "Names", names: "A", hash: "a".repeat(64) } },
      { sourceEnvironment: { _tag: "Names", hash: "a".repeat(64) } },
      { sourceEnvironment: { _tag: "Other", hash: "a".repeat(64) } },
      { generatedAtMs: Number.NaN },
      { generatedAtMs: Number.POSITIVE_INFINITY },
      { entries: null },
      { entries: {} },
      { entries: [null] },
      { entries: new Array(1) },
      ...["_tag", "id", "summary", "sourceKind", "visibility", "input"].map((key) => ({
        entries: [without(entry, key)],
      })),
      ...[{ id: 1 }, { summary: false }, { hidden: "false" }, { service: null }, { source: "shell" }].map(
        (patch) => ({ entries: [{ ...entry, ...patch }] }),
      ),
      ...[false, "true", null, 1].map((disabled) => ({ entries: [{ ...entry, hidden: true, disabled }] })),
      ...[false, "true", null, 1, undefined].map((wrapper) => ({ entries: [{ ...entry, wrapper }] })),
      { entries: [{ ...entry, hidden: false, disabled: true }] },
    ])("rejects malformed common fields %#", (patch) => {
      // Given
      const bytes = currentAbiBytes(magic, { ...payload, ...patch });
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
      const bytes = currentAbiBytes(magic, { ...payload, entries: [{ ...entry, input: malformedInput }] });
      // When / Then
      expect(decode(bytes)).toBeNull();
    });
    test("roundtrips SDK-encoded declarations", () => {
      // Given
      const payloadWithEncodedInput = { ...payload, entries: [{ ...entry, input: encodedInput }] };
      // When
      const decoded = decode(currentAbiBytes(magic, payloadWithEncodedInput));
      // Then
      expect(decoded).toEqual({ ...payload, entries: [entry] });
    });
    test("roundtrips help forwarding metadata", () => {
      // Given
      const expected = { ...payload, entries: [{ ...entry, wrapper: true as const }] };
      // When / Then
      expect(decode(currentAbiBytes(magic, expected))).toEqual(expected);
    });
    test("roundtrips disabled metadata separately from internal visibility", () => {
      // Given
      const expected = {
        ...payload,
        entries: [
          { ...entry, visibility: "internal" as const },
          {
            id: entry.id,
            summary: entry.summary,
            sourceKind: "tooling" as const,
            visibility: "public" as const,
            _tag: "Disabled" as const,
            source: { path: ".lando.yml", task: "deploy" },
          },
        ],
      };
      // When / Then
      expect(decode(currentAbiBytes(magic, expected))).toEqual(expected);
    });
    test.each([true, false])("roundtrips empty input with argument policy %s", (acceptsArguments) => {
      // Given
      const emptyInput = Result.getOrThrowWith(
        normalizeToolingInput("empty", acceptsArguments ? {} : { arguments: false }),
        (error) => error,
      );
      const expected = { ...payload, entries: [{ ...entry, input: emptyInput }] };
      // When / Then
      expect(decode(currentAbiBytes(magic, expected))).toEqual(expected);
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
  { _tag: "Complete" as const, hash: "b".repeat(64) },
  { _tag: "Names" as const, names: ["A", "Z"], hash: "c".repeat(64) },
  { _tag: "Names" as const, names: [], hash: "d".repeat(64) },
])("roundtrips sourceEnvironment arm %#", (sourceEnvironment) => {
  const expected = { ...app, sourceEnvironment };
  expect(decodeAppCommandIndex(encodeAppCommandIndex(expected))).toEqual(expected);
});

test.each([{ names: ["B", "A"] }, { names: ["A", "A"] }, { names: ["A", "A", "B"] }, { names: [1] }])(
  "rejects malformed Names sourceEnvironment %#",
  (patch) => {
    expect(
      decodeAppCommandIndex(
        currentAbiBytes("LCAC", {
          ...app,
          sourceEnvironment: { _tag: "Names", hash: "e".repeat(64), ...patch },
        }),
      ),
    ).toBeNull();
  },
);

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
  const bytes = currentAbiBytes("LCAC", payload);
  // When / Then
  expect(decodeAppCommandIndex(bytes)).toBeNull();
});
