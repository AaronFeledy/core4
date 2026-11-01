import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ClaimCursor, isResidualDiagnostic } from "../src/claims.ts";
import { lowerApi4Service } from "../src/lower-api4.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator, testPorts } from "./fixtures/test-ports.ts";

const translate = async (...texts: readonly string[]) => {
  const input = documentSet(
    texts.map((text, index) => ({
      ...document(index === 0 ? ".lando.yml" : ".lando.local.yml", text),
      layerId: index === 0 ? "canonical" : "local",
    })),
  );
  const result = await Effect.runPromise(makeTestTranslator().translate(input));
  expect(result.diagnostics.filter(isResidualDiagnostic)).toEqual([]);
  return result;
};

test.each([
  {
    fields: "environment: {PGPORT: 5433}, overrides: {environment: {PGPORT: null}}",
    path: ["overrides", "environment", "PGPORT"],
  },
  { fields: 'environment: ["PGPORT=5433", "PGPORT"]', path: ["environment", 1] },
  {
    fields: "environment: {PGPORT: 5433}, overrides: {environment: {PGPORT: {bad: value}}}",
    path: ["overrides", "environment", "PGPORT"],
  },
])("rejects an unresolved winning listener when $fields", async ({ fields, path }) => {
  // Given
  const text = `services: {db: {type: postgres:17, ${fields}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).not.toHaveProperty("services.db.port");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "unsupported",
      sourceId: ".lando.yml",
      keyPath: ["services", "db", ...path],
    }),
  );
});

test.each(["bad", "-2", "65536"])("accounts for invalid catalog port %s", async (port) => {
  // Given
  const text = `services: {web: {type: node:24, port: ${port}}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).not.toHaveProperty("services.web.port");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      kind: "dropped",
      sourceId: ".lando.yml",
      keyPath: ["services", "web", "port"],
      message: expect.stringContaining("not a TCP port number"),
    }),
  ]);
});

test("reports authored unknown keys even when a later layer disables the service", async () => {
  // Given
  const base = "services: {web: {type: node:24, typo: x}}";
  const local = "services: {web: false}";
  // When
  const result = await translate(base, local);
  // Then
  expect(result.diagnostics.filter(({ keyPath }) => keyPath.includes("typo"))).toEqual([
    expect.objectContaining({
      kind: "dropped",
      sourceId: ".lando.yml",
      keyPath: ["services", "web", "typo"],
    }),
  ]);
});

test.each([
  { base: "compose: [base.yml]", local: "compose: [local.yml]", path: ["compose", 0] },
  {
    base: "proxy: {web: [base.example.test]}",
    local: "proxy: {web: [local.example.test]}",
    path: ["proxy", "web", 0],
  },
  {
    base: "events: {pre-start: [echo base]}",
    local: "events: {pre-start: [echo local]}",
    path: ["events", "pre-start", 0],
  },
])("reports authored local indices for $path", async ({ base, local, path }) => {
  // Given
  const service = "services: {web: {type: node:24}}\n";
  // When
  const result = await translate(service + base, local);
  // Then
  const localDiagnostics = result.diagnostics.filter(({ sourceId }) => sourceId === ".lando.local.yml");
  expect(localDiagnostics).toContainEqual(expect.objectContaining({ keyPath: path }));
  expect(localDiagnostics.some(({ keyPath }) => keyPath.at(-1) === 1)).toBe(false);
});

test("blocks a tagged healthcheck without reading the referenced file", async () => {
  // Given
  const text = "services: {web: {api: 4, type: lando, image: alpine, healthcheck: !load absent.yml}}";
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).not.toHaveProperty("services.web");
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "unsupported",
      sourceId: ".lando.yml",
      keyPath: ["services", "web", "healthcheck"],
    }),
  );
});

test.each(["!", "!/"])("drops pathless mount include %s", async (mask) => {
  // Given
  const text = `services: {web: {api: 4, type: lando, image: alpine, mounts: [{source: ., target: /site, excludes: [${JSON.stringify(mask)}, "!cache/keep"]}]}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.mounts", [
    { source: ".", target: "/site", includes: ["cache/keep"] },
  ]);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "dropped",
      sourceId: ".lando.yml",
      keyPath: ["services", "web", "mounts", 0, "excludes", 0],
      message: expect.stringContaining("names no path"),
    }),
  );
});

test.each(["!", "!/"])("locates a pathless top-level include %s at its authored key", async (mask) => {
  // Given
  const text = `excludes: [${JSON.stringify(mask)}, "!cache/keep"]\nservices: {web: {api: 4, type: lando, image: alpine}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.appMount.includes", ["cache/keep"]);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "dropped",
      sourceId: ".lando.yml",
      keyPath: ["excludes", 0],
      message: expect.stringContaining("names no path"),
    }),
  );
});

test.each([".", "./"])("promotes the last long-form l337 app-root bind %s", async (source) => {
  // Given
  const text = `services: {web: {api: 4, type: l337, image: alpine, volumes: [".:/first", {type: bind, source: '${source}', target: /site, read_only: true}, "./cache:/cache"]}}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.appMount", {
    target: "/site",
    readOnly: true,
  });
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.volumes", [".:/first", "./cache:/cache"]);
  expect(result.diagnostics.filter(({ keyPath }) => keyPath.includes("volumes"))).toEqual([]);
});

test("claims every authored long-form bind field when promoting an l337 app mount", () => {
  // Given
  const service = {
    api: 4,
    type: "l337",
    image: "alpine",
    volumes: [{ type: "bind", source: ".", target: "/site", read_only: true }],
  };
  const ctx = {
    serviceName: "web",
    keyPath: ["services", "web"],
    fallbackSourceId: ".lando.yml",
    serviceFacts: testPorts().serviceFacts,
    occurrenceAt: () => undefined,
    topLevel: { excludes: [], includes: [] },
  };
  // When
  const result = lowerApi4Service(service, { ...ctx, cursor: new ClaimCursor(service, ctx) });
  // Then
  expect(result.patch.appMount).toEqual({ target: "/site", readOnly: true });
  for (const key of ["type", "source", "target", "read_only"]) {
    expect(result.claims).toContainEqual(["volumes", 0, key]);
  }
});

test.each(["24.banana", "24.7-rc1", "24.", "24.7..0"])(
  "rejects a nonnumeric release relationship %s",
  async (version) => {
    // Given
    const text = `services: {web: {type: 'node:${version}'}}`;
    // When
    const result = await translate(text);
    // Then
    expect(result.outputs[0]?.fragment).not.toHaveProperty("services.web");
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "unsupported",
        sourceId: ".lando.yml",
        keyPath: ["services", "web", "type"],
      }),
    );
  },
);
