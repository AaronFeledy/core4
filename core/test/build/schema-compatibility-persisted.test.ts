import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  acceptCompatibilityExceptions,
  classifySchemaChange,
} from "../../../scripts/schema-compatibility/classifier.ts";
import { parseCompatibilityExceptions } from "../../../scripts/schema-compatibility/exceptions.ts";
import { finding } from "../../../scripts/schema-compatibility/fingerprint.ts";
import {
  type CompatibilityException,
  type JsonSchema,
  type JsonValue,
  type PersistedStoreId,
  isJsonObject,
} from "../../../scripts/schema-compatibility/model.ts";
import {
  buildPersistedSurfaceStores,
  readPersistedStoreVersions,
} from "../../../scripts/schema-compatibility/persisted.ts";
import { loadBasePersistedStoreVersions } from "../../../scripts/schema-compatibility/store-versions.ts";
import { suggestCompatibilityExceptions } from "../../../scripts/schema-compatibility/suggest-exceptions.ts";
import { loadWorkingSchemaArtifacts } from "../../../scripts/schema-compatibility-artifacts.ts";

const storeVersions = { "applied-state": 4, "tunnel-registry": 2 } as const;
const persistedStoresBySurface = new Map([["schema:HostAliasPlan", new Set(["applied-state"] as const)]]);
const narrowedHostname = (verdict: "breaking" | "unknown") =>
  finding(verdict, "keyword-changed", "$", "Narrowed hostname.", {
    before: { type: "string" },
    after: { type: "string", pattern: "^[a-z]+$" },
  });
const exception = {
  fingerprint: narrowedHostname("unknown").fingerprint,
  changeKind: "keyword-changed",
  locations: [{ surface: "schema:HostAliasPlan", path: "$" }],
  justification: "Applied-state v4 migrates historical names.",
} satisfies CompatibilityException;

test("covers every published ref in the real AppliedAppPlan and tunnel schema documents", async () => {
  const artifacts = await loadWorkingSchemaArtifacts(resolve(import.meta.dir, "../../.."));
  const schemas = new Map(
    [...artifacts]
      .filter(([id]) => id.startsWith("schema:"))
      .map(([id, artifact]) => [id.slice(7), artifact.schema]),
  );
  const stores = buildPersistedSurfaceStores(schemas, new Set(schemas.keys()));
  for (const [root, store] of [
    ["AppliedAppPlan", "applied-state"],
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
    new Map([["AppliedAppPlan", {}]]),
    new Set(["AppliedAppPlan", "HistoricalOnly"]),
    new Map([["AppPlan", { $ref: "#/$defs/HistoricalOnly", $defs: { HistoricalOnly: { type: "string" } } }]]),
  );
  expect(stores.get("schema:HistoricalOnly")).toEqual(new Set(["applied-state"]));
});

test("discovers published definitions with numeric suffixes and excludes unrelated surfaces", () => {
  const stores = buildPersistedSurfaceStores(
    new Map([["AppliedAppPlan", { $ref: "#/$defs/Custom_1", $defs: { Custom_1: { type: "string" } } }]]),
    new Set(["AppliedAppPlan", "Custom", "Unrelated"]),
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
      ["AppliedAppPlan", { type: "object", properties: { nested: inline } }],
      ["NewInlineContract", inline],
      ["UnrelatedStringBrand", { type: "string" }],
    ]),
    new Set(["AppliedAppPlan", "NewInlineContract", "UnrelatedStringBrand"]),
  );
  expect(stores.get("schema:NewInlineContract")).toEqual(new Set(["applied-state"]));
  expect(stores.has("schema:UnrelatedStringBrand")).toBe(false);
});

test.each([
  { name: "event-only change needs no new applied-state migration", id: "EventStepPlan", accepted: true },
  {
    name: "narrowing a field still stored in applied state requires a migration",
    id: "RealizedField",
    accepted: false,
  },
])("$name", ({ id, accepted }) => {
  const oldField = { type: "string" };
  const narrowField = { type: "string", const: "kept" };
  const realized = { $ref: "#/$defs/RealizedField" };
  const before = new Map<string, JsonSchema>([
    [
      "AppPlan",
      {
        properties: { events: { $ref: "#/$defs/EventStepPlan" }, realized },
        $defs: { EventStepPlan: oldField, RealizedField: oldField },
      },
    ],
  ]);
  const after = new Map<string, JsonSchema>([
    [
      "AppliedAppPlan",
      {
        properties: { realized },
        $defs: { RealizedField: narrowField },
      },
    ],
  ]);
  const findings = classifySchemaChange(oldField, narrowField, "input");
  const surface = `schema:${id}`;
  const stores = buildPersistedSurfaceStores(
    after,
    new Set(["AppliedAppPlan", "EventStepPlan", "RealizedField"]),
    before,
  );
  const result = acceptCompatibilityExceptions(
    surface,
    findings,
    findings.map(({ fingerprint, changeKind, path }) => ({
      fingerprint,
      changeKind,
      locations: [{ surface, path }],
      justification: "Fixture narrowing.",
    })),
    { persistedStoresBySurface: stores, storeVersions, baseStoreVersions: { "applied-state": 4 } },
  );
  expect(result.map((finding) => finding.accepted)).toEqual([accepted]);
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
    const findings = [narrowedHostname(verdict)];
    const entries = [{ ...exception, ...(metadata === undefined ? {} : { persistedState: metadata }) }];
    const result = acceptCompatibilityExceptions("schema:HostAliasPlan", findings, entries, {
      persistedStoresBySurface,
      storeVersions,
    });
    expect(result[0]?.accepted).toBe(false);
    expect(result[0]?.message).toContain("when older readers cannot decode newly written values");
    expect(result[0]?.message).toContain("only if the current decoder cannot read them unchanged");
  });

  test.each([3, 4])(
    `requires an advanced current version for a persisted ${verdict} finding (base %s)`,
    (baseVersion) => {
      const findings = [narrowedHostname(verdict)];
      const entry: CompatibilityException = {
        ...exception,
        persistedState: { store: "applied-state", version: 4 },
      };
      const result = acceptCompatibilityExceptions("schema:HostAliasPlan", findings, [entry], {
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
    fingerprint: findings[0]?.fingerprint ?? "",
    changeKind: "type-changed",
    locations: [{ surface: "command:app:info", path: "$" }],
    justification: "Command output only.",
  };
  const result = acceptCompatibilityExceptions("command:app:info", findings, [entry], {
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
  const surface = "schema:RouteHostname";
  const entry: CompatibilityException = {
    ...exception,
    locations: [{ surface, path: "$" }],
    persistedState: metadata,
  };
  const result = acceptCompatibilityExceptions(surface, [narrowedHostname("unknown")], [entry], {
    storeVersions,
    baseStoreVersions: { "applied-state": 3, "tunnel-registry": 1 },
    persistedStoresBySurface: new Map([[surface, new Set(["applied-state", "tunnel-registry"] as const)]]),
  });
  expect(result[0]?.accepted).toBe(complete);
  expect(parseCompatibilityExceptions(JSON.stringify([entry]), "fixture")).toEqual([entry]);
});

test("suggests persisted metadata for every store a merged entry reaches", () => {
  // Given a reviewed applied-state entry and the same change on a tunnel-registry surface.
  const existing: CompatibilityException = {
    ...exception,
    persistedState: { store: "applied-state", version: 4 },
  };
  const located = { ...narrowedHostname("unknown"), surface: "schema:TunnelTarget" };

  // When the gate suggests the merged entry.
  const [suggestion] = suggestCompatibilityExceptions([located], [existing], {
    storeVersions,
    persistedStoresBySurface: new Map<string, ReadonlySet<PersistedStoreId>>([
      ["schema:HostAliasPlan", new Set(["applied-state"])],
      ["schema:TunnelTarget", new Set(["tunnel-registry"])],
    ]),
  });

  // Then its persistedState covers both stores at their current versions.
  expect(suggestion?.persistedState).toEqual([
    { store: "applied-state", version: 4 },
    { store: "tunnel-registry", version: 2 },
  ]);
});

const git = async (cwd: string, ...args: string[]) => {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};
const commitFiles = async (root: string, files: Readonly<Record<string, string>>, message: string) => {
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  await git(root, "add", "-A");
  await git(root, "commit", "-q", "-m", message);
};

test("loads store versions from the historical and current source layouts", async () => {
  // Given: main's layout kept the tunnel version in registry.ts; the current one has a constant.
  const repoRoot = resolve(import.meta.dir, "../../..");
  const root = await mkdtemp(join(tmpdir(), "lando-store-versions-"));
  try {
    await git(root, "init", "-q");
    await commitFiles(
      root,
      {
        "container-runtime/src/applied-state-migrate.ts": "export const APPLIED_STATE_VERSION = 3;\n",
        "engine/src/tunnel/registry.ts": "const registrySpec = {\n  version: 1,\n};\n",
      },
      "historical",
    );
    await git(root, "tag", "historical");
    const current = [
      "container-runtime/src/applied-state-migrate.ts",
      "engine/src/tunnel/registry-migrate.ts",
      "engine/src/tunnel/registry.ts",
    ];
    await commitFiles(
      root,
      Object.fromEntries(
        await Promise.all(current.map(async (path) => [path, await Bun.file(join(repoRoot, path)).text()])),
      ),
      "current",
    );
    // When / Then
    expect(await loadBasePersistedStoreVersions(root, "historical")).toEqual({
      "applied-state": 3,
      "tunnel-registry": 1,
    });
    expect(await loadBasePersistedStoreVersions(root, "HEAD")).toEqual(readPersistedStoreVersions());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
