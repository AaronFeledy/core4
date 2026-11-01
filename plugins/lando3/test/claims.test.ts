import { expect, test } from "bun:test";
import { LEGACY_TAGGED } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { ClaimCursor } from "../src/claims.ts";
import { type ServiceLoweringContext, mergePatches } from "../src/lowering-contract.ts";
import { rewrittenServiceKey } from "../src/service-diagnostics.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator, testPorts } from "./fixtures/test-ports.ts";

const ctx: ServiceLoweringContext = {
  serviceFacts: testPorts().serviceFacts,
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

test("leaves descendants unclaimed when a parent is inspected or diagnosed", () => {
  // Given a newly added nested field beneath a successfully rewritten parent.
  const cursor = new ClaimCursor({ config: { server: "server.conf", added: { flag: true } } }, ctx);
  // When the lowerer traverses the parent and maps only its known field.
  cursor.peek(["config"]);
  cursor.take(["config"]);
  cursor.take(["config", "server"]);
  const residual = cursor.residuals([
    rewrittenServiceKey({ ctx, relative: ["config"], message: "Renamed", remediation: "Review" }),
  ]);
  // Then the new leaf remains an independently located obligation.
  expect(residual.map(({ kind, keyPath }) => [kind, keyPath])).toEqual([
    ["dropped", ["services", "web", "config", "added", "flag"]],
  ]);
});

test("treats empty containers and tagged values as atomic obligations", () => {
  // Given empty collections and a reference marker.
  const cursor = new ClaimCursor(
    { array: [], object: {}, tagged: { [LEGACY_TAGGED]: true, tag: "!load", value: "missing" } },
    ctx,
  );
  // When only the empty array is deliberately accepted.
  cursor.acceptNoOp(["array"]);
  // Then marker metadata is never diagnosed as authored children.
  expect(cursor.residuals([]).map(({ keyPath }) => keyPath)).toEqual([
    ["services", "web", "object"],
    ["services", "web", "tagged"],
  ]);
});

test("merges independent lowerer claims without changing coordinates", () => {
  // Given two lowerers consuming different merged cells.
  const left = { patch: {}, diagnostics: [], claims: [["mounts", 2, "source"]] };
  const right = { patch: {}, diagnostics: [], claims: [["environment", 0]] };
  // When their patches are combined.
  const result = mergePatches(left, right);
  // Then the merged paths retain their array indices.
  expect(result.claims).toEqual([
    ["mounts", 2, "source"],
    ["environment", 0],
  ]);
});

test.each(["dropTree", "rejectTree", "reviewTree"] as const)(
  "covers all descendants only through explicit %s",
  (method) => {
    // Given a subtree intentionally disposed of as a unit.
    const cursor = new ClaimCursor({ setting: { child: [1, 2] } }, ctx);
    // When an explicit tree operation emits its disposition.
    const diagnostic = cursor[method](["setting"], "Disposition", "Configure by hand");
    // Then no residual duplicates that disposition.
    expect(cursor.residuals([diagnostic])).toEqual([]);
    expect(diagnostic.keyPath).toEqual(["services", "web", "setting"]);
  },
);

test.each([
  "config: {server: nginx.conf, future: {nested: true}}",
  "xdebug: {mode: debug, future: {nested: true}}",
])("diagnoses a new nested child beneath a rewritten parent: %s", async (fields) => {
  // Given a real document with a known rewritten parent and a new child.
  const translator = makeTestTranslator();
  const text = `services: {web: {type: php:8.3, ${fields}}}`;
  // When converting through the public translator surface.
  const result = await Effect.runPromise(translator.translate(documentSet([document(".lando.yml", text)])));
  // Then exactly one specialized diagnostic accounts for the unknown subtree.
  const diagnostics = result.diagnostics.filter(({ keyPath }) => keyPath.includes("future"));
  expect(diagnostics).toHaveLength(1);
  expect(diagnostics[0]).toMatchObject({ kind: "dropped", sourceId: ".lando.yml", span: expect.anything() });
});
