import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadWorkingSchemaArtifacts } from "../../../scripts/schema-compatibility-artifacts.ts";
import {
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";
import { parseCompatibilityExceptions } from "../../../scripts/schema-compatibility/exceptions.ts";
import {
  type CompatibilityException,
  type JsonSchema,
  type JsonValue,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import { buildPersistedSurfaceStores } from "../../../scripts/schema-compatibility/persisted.ts";
import { loadBasePersistedStoreVersions } from "../../../scripts/schema-compatibility/store-versions.ts";

const storeVersions = { "applied-state": 4, "tunnel-registry": 2 } as const;
const persistedStoresBySurface = new Map([["schema:HostAliasPlan", new Set(["applied-state"] as const)]]);
const exception = {
  surface: "schema:HostAliasPlan",
  changeKind: "keyword-changed",
  path: "$",
  justification: "Applied-state v4 migrates historical names.",
} as const;

test("covers every published ref in the real AppPlan and tunnel schema documents", async () => {
  const artifacts = await loadWorkingSchemaArtifacts(resolve(import.meta.dir, "../../.."));
  const schemas = new Map(
    [...artifacts]
      .filter(([id]) => id.startsWith("schema:"))
      .map(([id, artifact]) => [id.slice(7), artifact.schema]),
  );
  const stores = buildPersistedSurfaceStores(schemas, new Set(schemas.keys()));
  for (const [root, store] of [
    ["AppPlan", "applied-state"],
    ["TunnelSession", "tunnel-registry"],
  ] as const) {
    const schema = schemas.get(root);
    if (schema === undefined) throw new Error(`Missing published ${root}`);
    const pending: JsonValue[] = [schema];
    while (pending.length > 0) {
      const node = pending.pop();
      if (Array.isArray(node)) pending.push(...node);
      else if (isJsonObject(node)) {
        if (typeof node.$ref === "string") {
          const id = node.$ref.split("/").at(-1)?.replace(/_\d+$/, "");
          if (id !== undefined && schemas.has(id)) expect(stores.get(`schema:${id}`)?.has(store)).toBe(true);
        }
        pending.push(...Object.values(node));
      }
    }
  }
  expect(stores.get("schema:HostAliasPlan")).toEqual(new Set(["applied-state"]));
  expect(stores.get("schema:CertificatePlan")).toEqual(new Set(["applied-state"]));
  expect(stores.get("schema:MountPlan")).toEqual(new Set(["applied-state"]));
  expect(stores.get("schema:EndpointPlan")).toEqual(new Set(["applied-state"]));
  expect(stores.get("schema:HealthcheckPlan")).toEqual(new Set(["applied-state"]));
  expect(stores.get("schema:TunnelStatus")).toEqual(new Set(["tunnel-registry"]));
  expect(stores.get("schema:TunnelTarget")).toEqual(new Set(["tunnel-registry"]));
  expect(stores.has("schema:TunnelSessionFilter")).toBe(false);
});

test("keeps removed baseline ref targets classified as persisted", () => {
  const stores = buildPersistedSurfaceStores(
    new Map([["AppPlan", {}]]),
    new Set(["AppPlan", "HistoricalOnly"]),
    new Map([["AppPlan", { $ref: "#/$defs/HistoricalOnly", $defs: { HistoricalOnly: { type: "string" } } }]]),
  );
  expect(stores.get("schema:HistoricalOnly")).toEqual(new Set(["applied-state"]));
});

test("discovers published definitions with numeric suffixes and excludes unrelated surfaces", () => {
  const stores = buildPersistedSurfaceStores(
    new Map([["AppPlan", { $ref: "#/$defs/Custom_1", $defs: { Custom_1: { type: "string" } } }]]),
    new Set(["AppPlan", "Custom", "Unrelated"]),
  );
  expect(stores.get("schema:Custom")).toEqual(new Set(["applied-state"]));
  expect(stores.has("schema:Unrelated")).toBe(false);
});

test("discovers inline published schemas without requiring a reference or an inventory entry", () => {
  const inline = {
    type: "object",
    properties: { durable: { type: "string", const: "kept" } },
    required: ["durable"],
  };
  const stores = buildPersistedSurfaceStores(
    new Map<string, JsonSchema>([
      ["AppPlan", { type: "object", properties: { nested: inline } }],
      ["NewInlineContract", inline],
      ["UnrelatedStringBrand", { type: "string" }],
    ]),
    new Set(["AppPlan", "NewInlineContract", "UnrelatedStringBrand"]),
  );
  expect(stores.get("schema:NewInlineContract")).toEqual(new Set(["applied-state"]));
  expect(stores.has("schema:UnrelatedStringBrand")).toBe(false);
});

test("parses persisted migration metadata without dropping it", () => {
  const entry = {
    ...exception,
    persistedState: { store: "applied-state", version: 4 },
  } satisfies CompatibilityException;
  expect(parseCompatibilityExceptions(JSON.stringify([entry]), "fixture")).toEqual([entry]);
});

test.each([
  { store: "unknown", version: 4 },
  { store: "applied-state", version: 0 },
  { store: "applied-state", version: "4" },
])("rejects malformed migration metadata: %j", (persistedState) => {
  expect(() =>
    parseCompatibilityExceptions(JSON.stringify([{ ...exception, persistedState }]), "fixture"),
  ).toThrow();
});

for (const verdict of ["breaking", "unknown"] as const) {
  test.each([
    { label: "missing", metadata: undefined },
    { label: "stale", metadata: { store: "applied-state", version: 3 } },
    { label: "wrong store", metadata: { store: "tunnel-registry", version: 2 } },
  ] satisfies ReadonlyArray<{
    readonly label: string;
    readonly metadata: CompatibilityException["persistedState"];
  }>)(`rejects ${verdict} persisted findings with $label metadata`, ({ metadata }) => {
    const findings = [
      { verdict, changeKind: "keyword-changed", path: "$", message: "Narrowed hostname.", accepted: false },
    ];
    const entries = [{ ...exception, ...(metadata === undefined ? {} : { persistedState: metadata }) }];
    const result = acceptCompatibilityExceptions(exception.surface, findings, entries, {
      persistedStoresBySurface,
      storeVersions,
    });
    expect(result[0]?.accepted).toBe(false);
    expect(result[0]?.message).toContain("Bump");
    expect(result[0]?.message).toContain("migration");
  });

  test.each([3, 4])(
    `requires an advanced current version for a persisted ${verdict} finding (base %s)`,
    (baseVersion) => {
      const findings = [
        { verdict, changeKind: "keyword-changed", path: "$", message: "Narrowed hostname.", accepted: false },
      ];
      const entry: CompatibilityException = {
        ...exception,
        persistedState: { store: "applied-state", version: 4 },
      };
      const result = acceptCompatibilityExceptions(exception.surface, findings, [entry], {
        persistedStoresBySurface,
        storeVersions,
        baseStoreVersions: { "applied-state": baseVersion },
      });
      expect(result[0]?.accepted).toBe(baseVersion < 4);
    },
  );
}

test("still accepts non-persisted surfaces without migration metadata", () => {
  const findings = classifySchemaChange({ type: "string" }, { type: "number" }, "output");
  const entry = {
    surface: "command:app:info",
    changeKind: "type-changed",
    path: "$",
    justification: "Command output only.",
  };
  const result = acceptCompatibilityExceptions(entry.surface, findings, [entry], {
    persistedStoresBySurface,
    storeVersions,
  });
  expect(result[0]?.accepted).toBe(true);
});

test.each([false, true])("requires migrations for every store sharing a surface: complete %s", (complete) => {
  const metadata = [
    { store: "applied-state", version: 4 },
    ...(complete ? [{ store: "tunnel-registry", version: 2 } as const] : []),
  ] as const;
  const entry: CompatibilityException = {
    ...exception,
    surface: "schema:RouteHostname",
    persistedState: metadata,
  };
  const result = acceptCompatibilityExceptions(
    entry.surface,
    [{ verdict: "unknown", changeKind: entry.changeKind, path: "$", message: "Narrowed.", accepted: false }],
    [entry],
    {
      storeVersions,
      baseStoreVersions: { "applied-state": 3, "tunnel-registry": 1 },
      persistedStoresBySurface: new Map([
        [entry.surface, new Set(["applied-state", "tunnel-registry"] as const)],
      ]),
    },
  );
  expect(result[0]?.accepted).toBe(complete);
  expect(parseCompatibilityExceptions(JSON.stringify([entry]), "fixture")).toEqual([entry]);
});

test("loads actual baseline store versions for bump enforcement", async () => {
  expect(await loadBasePersistedStoreVersions(resolve(import.meta.dir, "../../.."), "140f4828f")).toEqual({
    "applied-state": 3,
    "tunnel-registry": 1,
  });
});
