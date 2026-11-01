import { expect, test } from "bun:test";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { isResidualDiagnostic } from "../src/claims.ts";
import { lowerCatalogCommon } from "../src/lower-catalog-common.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator, testPorts } from "./fixtures/test-ports.ts";

const ctx: ServiceLoweringContext = {
  serviceFacts: testPorts().serviceFacts,
  serviceName: "app",
  keyPath: ["services", "app"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};

test("pins the exact Lando 3 default when the catalog ships it", () => {
  // Given a catalog that still ships Lando 3's MySQL default.
  const context = { ...ctx, serviceFacts: { ...ctx.serviceFacts, mysql: { versions: ["5.7", "8.0"] } } };
  // When lowering an unversioned service.
  const result = lowerCatalogCommon({ type: "mysql" }, context);
  // Then the old default is preserved explicitly, without requesting review.
  expect(result.patch).toEqual({ type: "mysql:5.7" });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "rewritten", keyPath: [...ctx.keyPath, "type"] }),
  ]);
  expect(result.blocked).toBeUndefined();
});

test("narrows the Lando 3 default when only its release line ships", () => {
  // Given phpMyAdmin's 5.1 default and the shipped 5 line.
  const service = { type: "phpmyadmin" };
  // When lowering the default.
  const result = lowerCatalogCommon(service, ctx);
  // Then the line is pinned and the lost exact release requires review.
  expect(result.patch).toEqual({ type: "phpmyadmin:5" });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "needs-review", keyPath: [...ctx.keyPath, "type"] }),
  ]);
  expect(result.diagnostics[0]?.message).toContain("Lando 3 used phpmyadmin 5.1");
  expect(result.blocked).toBeUndefined();
});

test.each([
  ["mysql", "5.7"],
  ["postgres", "10"],
  ["node", "14"],
  ["tomcat", "8"],
] as const)("keeps %s unversioned when its Lando 3 default is unavailable", (type, version) => {
  // Given an unversioned-capable type whose old default is not shipped.
  const service = { type };
  // When lowering the service.
  const result = lowerCatalogCommon(service, ctx);
  // Then version choice remains with Lando 4 and the change is explicit.
  expect(result.patch.type).toBe(type);
  expect(result.blocked).toBeUndefined();
  expect(result.diagnostics.filter(({ keyPath }) => keyPath.at(-1) === "type")).toEqual([
    expect.objectContaining({ kind: "needs-review", keyPath: [...ctx.keyPath, "type"] }),
  ]);
  expect(result.diagnostics[0]?.message).toContain(`Lando 3 used ${type} ${version}`);
  expect(result.diagnostics[0]?.message).toContain("will choose");
  if (type === "node") {
    expect(result.diagnostics[0]?.message).toContain(".nvmrc");
    expect(result.diagnostics[0]?.message).toContain("package.json");
  }
});

test.each([
  ["php", "7.4"],
  ["go", "1.26"],
  ["python", "3.7"],
  ["ruby", "2.7"],
] as const)("blocks %s when its required Lando 3 default is unavailable", (type, version) => {
  // Given a version-required service with an unshipped default.
  const service = { type };
  // When lowering it.
  const result = lowerCatalogCommon(service, ctx);
  // Then no type is invented and remediation lists every supported choice.
  expect(result.blocked).toBe(true);
  expect(result.patch).toEqual({});
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "unsupported", keyPath: [...ctx.keyPath, "type"] }),
  ]);
  expect(result.diagnostics[0]?.message).toContain(`Lando 3 used ${type} ${version}`);
  expect(result.diagnostics[0]?.remediation).toContain(ctx.serviceFacts[type]?.versions.join(", "));
});

test("emits no default note when the type publishes no versions", () => {
  // Given Apache has a Lando 3 default but publishes no Lando 4 versions.
  const service = { type: "apache" };
  // When lowering it.
  const result = lowerCatalogCommon(service, ctx);
  // Then its bare type is preserved silently.
  expect(result.patch).toEqual(service);
  expect(result.diagnostics).toEqual([]);
  expect(result.blocked).toBeUndefined();
});

test.each([
  ["node:24.7.0", "node:24"],
  ["php:8.2.10", "php:8.2"],
] as const)("requests review when exact release %s narrows", (type, expected) => {
  // Given an exact legacy release within a shipped line.
  const service = { type };
  // When lowering it.
  const result = lowerCatalogCommon(service, ctx);
  // Then the shipped line is emitted with one type-level review.
  expect(result.patch).toEqual({ type: expected });
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ kind: "needs-review", keyPath: [...ctx.keyPath, "type"] }),
  ]);
});

test("strictly decodes every translated layer with version notes and no residual diagnostics", async () => {
  // Given defaults, exact releases, an unsupported default, and a local layer.
  const input = documentSet([
    document(
      ".lando.yml",
      "services: {db: {type: mysql}, node: {type: node}, admin: {type: phpmyadmin}, web: {type: apache}, php: {type: php}, exact: {type: node:24.7.0}}",
    ),
    { ...document(".lando.local.yml", "services: {db: {portforward: true}}"), layerId: "local" },
  ]);
  // When translating the full document set.
  const result = await Effect.runPromise(makeTestTranslator().translate(input));
  // Then every emitted layer is strict authoring data and every key is accounted for.
  expect(result.outputs).toHaveLength(2);
  for (const output of result.outputs) {
    expect(() =>
      Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(output.fragment),
    ).not.toThrow();
  }
  expect(result.outputs[0]?.fragment).toHaveProperty("services.admin.type", "phpmyadmin:5");
  expect(result.outputs[0]?.fragment).toHaveProperty("services.exact.type", "node:24");
  expect(result.diagnostics.filter(isResidualDiagnostic)).toEqual([]);
});
