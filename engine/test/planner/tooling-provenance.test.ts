import { expect, test } from "bun:test";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { AbsolutePath, AppId, AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Schema } from "effect";
import {
  attachEffectiveTooling,
  connectionClientsForPlan,
  disabledToolingSourceForPlan,
  effectiveToolingForPlan,
  resolveEffectiveTooling,
  toolingIssueSourceForPlan,
  toolingOriginAt,
  toolingOriginForPlan,
  toolingRelatedLocationsForPlan,
  toolingSourcePathForPlan,
} from "../../src/planner/effective-tooling.ts";

const base: AppPlan = {
  id: AppId.make("provenance"),
  name: "provenance",
  slug: "provenance",
  root: AbsolutePath.make("/tmp/provenance"),
  provider: ProviderId.make("lando"),
  services: {},
  routes: [],
  stores: [],
  fileSync: [],
  extensions: {},
  metadata: {
    resolvedAt: DateTime.makeUnsafe("2026-08-16T00:00:00Z"),
    source: "/recorded/application/.lando.yml",
    runtime: 4,
  },
};

test("persisted tooling resolves field prefixes to winning defaults, local fields and service contributors", async () => {
  const compiled = await Effect.runPromise(
    loadAuthoredDocuments(
      [
        {
          file: "/tmp/provenance/.lando.yml",
          value: {
            services: { web: { type: "php" } },
            toolingDefaults: {
              service: ":host",
              dir: "/default",
              env: { DEFAULT: "a", SHARED: "b" },
              vars: { DEFAULT: "a", SHARED: "b" },
            },
            tooling: { inspect: { cmd: "echo root" } },
          },
        },
        {
          file: "/tmp/provenance/.lando.local.yml",
          value: {
            tooling: { inspect: { cmd: "echo local", env: { SHARED: "c" }, vars: { SHARED: "d" } } },
          },
        },
      ],
      { appRoot: String(base.root), file: "/tmp/provenance/.lando.yml" },
    ),
  );
  const resolution = resolveEffectiveTooling({
    landofile: compiled.document,
    services: [
      { name: "zeta", serviceTypeId: "node", tooling: { php: { cmd: "wrong contributor" } } },
      { name: "web", serviceTypeId: "php", tooling: { php: { cmd: "php" } }, connectionClientNames: ["php"] },
    ],
  });
  const plan = Schema.decodeUnknownSync(AppPlan)(
    Schema.encodeSync(AppPlan)(attachEffectiveTooling(base, resolution.tasks, resolution)),
  );
  for (const [name, relative, layer, path] of [
    ["inspect", ["cmd"], "local", ["tooling", "inspect", "cmd"]],
    ["inspect", ["service"], "canonical", ["toolingDefaults", "service"]],
    ["inspect", ["dir"], "canonical", ["toolingDefaults", "dir"]],
    ["inspect", ["env", "DEFAULT"], "canonical", ["toolingDefaults", "env", "DEFAULT"]],
    ["inspect", ["env", "SHARED"], "local", ["tooling", "inspect", "env", "SHARED"]],
    ["inspect", ["vars", "DEFAULT", "nested"], "canonical", ["toolingDefaults", "vars", "DEFAULT"]],
    ["inspect", ["vars", "SHARED"], "local", ["tooling", "inspect", "vars", "SHARED"]],
    ["php", ["cmd", 0], "canonical", ["services", "web", "type"]],
    ["php", ["service"], "canonical", ["services", "web", "type"]],
    ["php", ["env", "DEFAULT"], "canonical", ["toolingDefaults", "env", "DEFAULT"]],
  ] as const) {
    expect(toolingIssueSourceForPlan(plan, name, relative)).toEqual({
      file: `/tmp/provenance/.lando${layer === "local" ? ".local" : ""}.yml`,
      layer,
      path,
    });
  }
  expect(connectionClientsForPlan(plan)).toEqual({ php: ServiceName.make("web") });
  expect(toolingRelatedLocationsForPlan(plan, "inspect", [["cmd"], ["env", "DEFAULT"]])).toEqual([
    {
      path: ["tooling", "inspect", "cmd"],
      source: {
        file: "/tmp/provenance/.lando.local.yml",
        layer: "local",
        path: ["tooling", "inspect", "cmd"],
      },
    },
    {
      path: ["tooling", "inspect", "env", "DEFAULT"],
      source: {
        file: "/tmp/provenance/.lando.yml",
        layer: "canonical",
        path: ["toolingDefaults", "env", "DEFAULT"],
      },
    },
  ]);
});

test("unversioned applied tooling retains executable intent and internal/client ownership without fabricated sources", () => {
  const legacy = {
    tasks: { psql: { cmd: ["psql"], service: "database" }, off: { disabled: true } },
    internalNames: ["psql"],
    connectionClients: { psql: "database" },
    disabledSources: { off: "/old/.lando.local.yml" },
  };
  const plan = Schema.decodeUnknownSync(AppPlan)({
    ...Schema.encodeSync(AppPlan)(base),
    extensions: { "@lando/core/effective-tooling": legacy },
  });
  const tasks = effectiveToolingForPlan(plan);
  expect(tasks).toEqual(legacy.tasks);
  expect(getInternalToolingTasks(tasks ?? {})).toEqual(["psql"]);
  expect(connectionClientsForPlan(plan)).toEqual({ psql: ServiceName.make("database") });
  expect(toolingIssueSourceForPlan(plan, "psql", ["cmd"])).toBeUndefined();
  expect(disabledToolingSourceForPlan(plan, "off")).toBeUndefined();
  expect(toolingSourcePathForPlan(plan, "off")).toBe("/recorded/application/.lando.yml");
  expect(toolingOriginForPlan(plan, "off", ["disabled"])).toEqual({ _tag: "Unknown" });
  expect(plan.extensions["@lando/core/effective-tooling"]).toEqual(legacy);
});

test("missing composition sources remain explicitly Unknown through attachment", () => {
  const resolution = resolveEffectiveTooling({
    landofile: { tooling: { inspect: { cmd: "echo ok" } } },
    services: [],
  });
  const plan = attachEffectiveTooling(base, resolution.tasks, resolution);
  expect(toolingOriginAt(resolution.provenance, "inspect", ["cmd"])).toEqual({ _tag: "Unknown" });
  expect(toolingIssueSourceForPlan(plan, "inspect", ["cmd"])).toBeUndefined();
  expect(toolingSourcePathForPlan(plan, "inspect")).toBe("/recorded/application/.lando.yml");
  expect(toolingOriginForPlan(plan, "inspect", ["cmd"])).toEqual({ _tag: "Unknown" });
});

test.each([
  { version: 2, provenance: {} },
  { version: 3, provenance: {} },
])(
  "rejects malformed or future tooling extensions without treating them as applied legacy (%j)",
  (fields) => {
    const plan = {
      ...base,
      extensions: {
        "@lando/core/effective-tooling": {
          tasks: { inspect: { cmd: "echo ok" } },
          internalNames: [],
          connectionClients: {},
          ...fields,
        },
      },
    };
    expect(() => effectiveToolingForPlan(plan)).toThrow();
  },
);
