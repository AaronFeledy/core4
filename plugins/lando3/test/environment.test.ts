import { expect, test } from "bun:test";
import { Effect } from "effect";
import { lowerComposeFields } from "../src/compose-fields.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

test("keeps valid siblings and claims superseded list assignments", async () => {
  // Given
  const input = documentSet([
    document(
      ".lando.yml",
      'services: {db: {type: postgres:17, environment: ["A=1", "PGPORT=5432", "A=2", "PGPORT=5433", "BAD"]}}',
    ),
  ]);
  // When
  const result = await Effect.runPromise(makeTestTranslator().translate(input));
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db", {
    type: "postgres:17",
    port: 5433,
    environment: { A: "2" },
  });
  expect(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))).toEqual([
    { kind: "needs-review", keyPath: ["services", "db", "environment", 3] },
    { kind: "dropped", keyPath: ["services", "db", "environment", 4] },
  ]);
});

test("locates a replacement list listener in the local authored layer", async () => {
  // Given
  const local = {
    ...document(".lando.local.yml", 'services: {db: {environment: ["PGPORT=5433"]}}'),
    layerId: "local",
  };
  const input = documentSet([
    document(".lando.yml", 'services: {db: {type: postgres:17, environment: ["X=1"]}}'),
    local,
  ]);
  // When
  const result = await Effect.runPromise(makeTestTranslator().translate(input));
  // Then
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      kind: "needs-review",
      sourceId: local.sourceId,
      keyPath: ["services", "db", "environment", 0],
      span: expect.any(Object),
    }),
  ]);
});

test.each([
  ["{LANDO_HOST_IP: 1.2.3.4}", "LANDO_HOST_IP"],
  ['["KEEP=1", "LANDO_HOST_IP=1.2.3.4"]', 1],
] as const)("locates host-IP removal from overrides %s", async (environment, key) => {
  // Given
  const input = documentSet([
    document(
      ".lando.yml",
      `services: {web: {type: nginx, overrides: {environment: ${environment}, labels: [bare, "explicit=value"]}}}`,
    ),
  ]);
  // When
  const result = await Effect.runPromise(makeTestTranslator().translate(input));
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.labels", { bare: "", explicit: "value" });
  expect(result.diagnostics.filter(({ keyPath }) => keyPath.includes("environment"))).toEqual([
    expect.objectContaining({
      kind: "rewritten",
      keyPath: ["services", "web", "overrides", "environment", key],
    }),
  ]);
});

test.each([
  ['environment: ["GOOD=1", 7, "INHERITED", "=bad", "ALSO=2"]', 3],
  ["environment: {GOOD: 1, NULL: null, OBJECT: {nested: bad}, ALSO: 2}", 2],
] as const)(
  "diagnoses each invalid environment value without losing siblings: %s",
  async (fields, dropped) => {
    // Given
    const input = documentSet([
      document(".lando.yml", `services: {web: {api: 4, type: lando, image: alpine, ${fields}}}`),
    ]);
    // When
    const result = await Effect.runPromise(makeTestTranslator().translate(input));
    // Then
    expect(result.outputs[0]?.fragment).toHaveProperty("services.web.environment", { GOOD: "1", ALSO: "2" });
    expect(result.diagnostics.filter(({ kind }) => kind === "dropped")).toHaveLength(dropped);
    expect(result.diagnostics.some(({ message }) => message.startsWith("Unclaimed"))).toBe(false);
  },
);

test.each(["environment", "build-args"] as const)(
  "does not inherit host values under the %s policy",
  (policy) => {
    // Given
    const values = ["GOOD=1", "PATH", 42, "GOOD=2", "EMPTY="];
    const input = policy === "environment" ? { environment: values } : { build: { args: values } };
    // When
    const result = lowerComposeFields(
      input,
      {
        serviceName: "web",
        serviceFacts: {},
        keyPath: ["services", "web"],
        fallbackSourceId: "canonical",
        occurrenceAt: () => undefined,
        topLevel: { excludes: [], includes: [] },
      },
      { basePath: ["overrides"] },
    );
    // Then
    expect(result.patch).toEqual(
      policy === "environment"
        ? { environment: { GOOD: "2", EMPTY: "" } }
        : { build: { args: { GOOD: "2", EMPTY: "" } } },
    );
    expect(result.diagnostics.filter(({ kind }) => kind === "dropped")).toHaveLength(2);
  },
);
