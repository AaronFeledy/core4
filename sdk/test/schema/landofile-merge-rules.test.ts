import { expect, test } from "bun:test";
import {
  assertLayerMergeCompleteness,
  mergeLandofiles,
  mergeValues,
  resolveLayerMergeRule,
} from "@lando/sdk/landofile";
import {
  IncludeEntry,
  LandofileShape,
  LayerMergeRule,
  ServiceConfig,
  ToolingTaskShape,
  getEditorJsonSchema,
  getJsonSchema,
  layerMerge,
} from "@lando/sdk/schema";
import { Schema, SchemaTransformation } from "effect";
import "./landofile-route-layer-regressions.test.ts";

test("replaces event steps when a local layer repeats a service", () => {
  // Given inherited steps targeting different services.
  const base = {
    events: {
      "post-start": [
        { service: "appserver", cmd: "composer install" },
        { service: "database", cmd: "seed" },
      ],
    },
  };
  const local = { events: { "post-start": [{ service: "appserver", cmd: "echo local" }] } };
  // When a higher layer supplies its steps.
  const result: unknown = mergeLandofiles([base, local]);
  // Then only the local steps remain.
  expect(result).toEqual(local);
});

test.each(["cmds", "filters", "entries"])("replaces opaque extension arrays named %s", (key) => {
  // Given an opaque extension containing apparently named entries.
  const base = { "x-demo": { [key]: [{ name: "a", type: "one" }, { name: "b" }] } };
  const local = { "x-demo": { [key]: [{ name: "a", type: "two" }] } };
  // When the layers merge.
  const result = mergeLandofiles([base, local]);
  // Then opaque entries never acquire modeled collection semantics.
  expect(result).toEqual(local);
});

test.each([
  { left: ["a", "b"], right: { a: { condition: "service_healthy" } } },
  {
    left: { a: { condition: "service_started" }, b: { condition: "service_started" } },
    right: [{ service: "a", condition: "service_healthy" }],
  },
  { left: [{ service: "a" }, { service: "b" }], right: ["a", "c"] },
])("projects every dependency spelling across layers %j", ({ left, right }) => {
  const result = mergeValues(ServiceConfig, left, right, ["dependsOn"]);
  const expected =
    Array.isArray(right) && right.includes("c")
      ? [{ service: "a" }, { service: "b" }, { service: "c" }]
      : [
          { service: "a", condition: "service_healthy" },
          { service: "b", ...(Array.isArray(left) ? {} : { condition: "service_started" }) },
        ];
  expect(result).toEqual(expected);
});

test("resolves authored depends_on from the root codec", () => {
  expect(
    mergeValues(LandofileShape, ["a"], { b: { condition: "service_healthy" } }, [
      "services",
      "web",
      "depends_on",
    ]),
  ).toEqual([{ service: "a" }, { service: "b", condition: "service_healthy" }]);
});

test("logs match the same default basename id as schema decoding", () => {
  expect(
    mergeValues(
      ServiceConfig,
      [{ path: "/var/log/error.log", label: "inherited" }, { path: "/var/log/access.log" }],
      [{ id: "error.log", path: "/tmp/error.log" }],
      ["logs"],
    ),
  ).toEqual([
    { id: "error.log", path: "/tmp/error.log", label: "inherited" },
    { path: "/var/log/access.log" },
  ]);
});

test.each(["endpoints", "ports"])("merges %s only when every entry is named", (field) => {
  expect(
    mergeValues(
      ServiceConfig,
      [
        { name: "a", port: 80 },
        { name: "b", port: 90 },
      ],
      [{ name: "a", published: 8080 }],
      [field],
    ),
  ).toEqual([
    { name: "a", port: 80, published: 8080 },
    { name: "b", port: 90 },
  ]);
  expect(
    mergeValues(
      ServiceConfig,
      [{ name: "a", port: 80 }, { port: 90 }],
      [{ name: "a", published: 8080 }],
      [field],
    ),
  ).toEqual([{ name: "a", published: 8080 }]);
  expect(mergeValues(ServiceConfig, [{ name: "A" }], [{ name: "a" }], [field])).toEqual([
    { name: "A" },
    { name: "a" },
  ]);
});

test("a literal template route appends without decoding", () => {
  const local = [{ hostname: "{{ app.name }}.test" }];
  expect(mergeValues(ServiceConfig, ["a.test"], local, ["routes"])).toEqual(["a.test", ...local]);
});

test("all production merge roots declare their object arrays", () => {
  for (const root of [
    LandofileShape,
    ServiceConfig,
    Schema.Record(Schema.String, ToolingTaskShape),
    IncludeEntry,
  ])
    expect(() => assertLayerMergeCompleteness(root)).not.toThrow();
});

test("a newly modeled object array fails completeness", () => {
  const root = Schema.Struct({ added: Schema.Array(Schema.Struct({ name: Schema.String })) });
  expect(() => assertLayerMergeCompleteness(root)).toThrow("added");
});

test("unannotated scalar arrays replace implicitly while opaque values stay terminal", () => {
  const root = Schema.Struct({ names: Schema.Array(Schema.String), opaque: Schema.Unknown });
  expect(() => assertLayerMergeCompleteness(root)).not.toThrow();
  expect(resolveLayerMergeRule(root, ["names"]).descriptor).toEqual({ kind: "replace" });
  expect(
    mergeValues(
      root,
      { names: ["a"], opaque: { entries: [{ name: "a" }] } },
      { names: ["b"], opaque: { entries: [{ name: "b" }] } },
    ),
  ).toEqual({ names: ["b"], opaque: { entries: [{ name: "b" }] } });
});

test("completeness inspects encoded nested object arrays too", () => {
  const codec = Schema.Array(Schema.Struct({ value: Schema.String })).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform<string, ReadonlyArray<{ readonly value: string }>>({
        decode: () => "decoded",
        encode: () => [],
      }),
    ),
  );
  expect(() => assertLayerMergeCompleteness(Schema.Struct({ alternate: codec }))).toThrow("alternate");
});

test("union collection declarations must agree", () => {
  const root = Schema.Union([
    layerMerge(Schema.Array(Schema.Struct({ name: Schema.String })), { kind: "replace" }),
    layerMerge(Schema.Array(Schema.String), {
      kind: "keyed",
      identity: "endpoint-name",
      whenUnkeyed: "replace",
      onMatch: "merge",
    }),
  ]);
  expect(() => assertLayerMergeCompleteness(root)).toThrow("conflicting");
});

test("published schema artifacts carry serializable collection policies", () => {
  const artifact = JSON.stringify(getJsonSchema("LandofileShape"));
  expect(artifact).toContain('"x-lando-merge"');
  expect(artifact).toContain('"route-match"');
  expect(artifact).toContain('"filter-name-or-type"');
  expect(artifact).not.toContain("lando/schema/LayerMerge");
  expect(JSON.stringify(getEditorJsonSchema("LandofileShape"))).toContain('"x-lando-merge"');
  expect(Schema.decodeUnknownSync(LayerMergeRule)({ kind: "replace" })).toEqual({ kind: "replace" });
  expect(() => Schema.decodeUnknownSync(LayerMergeRule)({ kind: "keyed", identity: "guessed" })).toThrow();
});

test("opaque extension arrays replace even when their entries carry names", () => {
  expect(
    mergeLandofiles([
      { "x-demo": [{ name: "a" }, { name: "b" }] },
      { "x-demo": [{ name: "a", local: true }] },
    ]),
  ).toEqual({ "x-demo": [{ name: "a", local: true }] });
});

test("explicit properties beat record policies through Suspend", () => {
  const item = Schema.Struct({ name: Schema.String });
  const root = Schema.suspend(() =>
    Schema.StructWithRest(Schema.Struct({ special: layerMerge(Schema.Array(item), { kind: "replace" }) }), [
      Schema.Record(
        Schema.String,
        layerMerge(Schema.Array(item), {
          kind: "keyed",
          identity: "endpoint-name",
          whenUnkeyed: "replace",
          onMatch: "merge",
        }),
      ),
    ]),
  );
  expect(resolveLayerMergeRule(root, ["special"]).descriptor).toEqual({ kind: "replace" });
  expect(resolveLayerMergeRule(root, ["other"]).key({ name: "named" })).toBe("named");
});
