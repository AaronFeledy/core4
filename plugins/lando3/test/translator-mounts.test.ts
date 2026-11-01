import { expect, test } from "bun:test";
import { LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

const translate = (...texts: readonly string[]) => {
  const translator = makeTestTranslator();
  const documents = texts.map((text, index) => ({
    ...document(index === 0 ? ".lando.yml" : ".lando.local.yml", text),
    layerId: index === 0 ? ("canonical" as const) : ("local" as const),
  }));
  return Effect.runPromise(translator.translate(documentSet(documents)));
};
const yaml = (fields: string) =>
  `services: {web: {api: 4, type: lando, image: 'alpine:3.21', home: false, ${fields}}}`;
const decode = (fragment: unknown) =>
  Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(fragment);

test("translates the #1475 reproduction with source-located field drops", async () => {
  // Given
  const text = yaml("app-mount: {source: ./src, target: /site, owner: www-data}");
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs).toHaveLength(1);
  expect(result.outputs.map(({ fragment }) => decode(fragment))).toMatchObject([
    { services: { web: { appMount: { target: "/site" } } } },
  ]);
  const drops = result.diagnostics.filter((entry) => entry.kind === "dropped");
  expect(drops.map((entry) => entry.keyPath)).toEqual([
    ["services", "web", "app-mount", "source"],
    ["services", "web", "app-mount", "owner"],
  ]);
  expect(drops.every((entry) => entry.sourceId === ".lando.yml" && entry.span !== undefined)).toBe(true);
  expect(drops[0]?.message).toContain("Lando 3 always mounted the app root");
});

test.each([
  {
    fields: "app-mount: {src: ./src, dest: /site}",
    output: { appMount: { target: "/site" } },
    diagnostics: [["dropped", "app-mount", "src"]],
  },
  {
    fields: "app-mount: '/site:ro'",
    output: { appMount: { target: "/site", readOnly: true } },
    diagnostics: [],
  },
  {
    fields: "appMount: /a, app-mount: /b",
    output: { appMount: { target: "/a" } },
    diagnostics: [["dropped", "app-mount"]],
  },
  {
    fields: "mounts: [{src: ./a, dest: /b}]",
    output: { mounts: [{ source: "./a", target: "/b" }] },
    diagnostics: [],
  },
  {
    fields: "mounts: ['./a:/b:cached']",
    output: { mounts: [{ source: "./a", target: "/b" }] },
    diagnostics: [["rewritten", "mounts", 0]],
  },
  {
    fields: "mounts: [{source: ./a, target: /b, read_only: true}]",
    output: { mounts: [{ source: "./a", target: "/b", readOnly: true }] },
    diagnostics: [],
  },
  {
    fields: "mounts: [{source: ./a, target: /b, readOnly: true}]",
    output: { mounts: [{ source: "./a", target: "/b" }] },
    diagnostics: [["dropped", "mounts", 0, "readOnly"]],
  },
  {
    fields: "mounts: [{source: ./a, target: /b, scope: app, instructions: x}]",
    output: { mounts: [{ source: "./a", target: "/b" }] },
    diagnostics: [
      ["dropped", "mounts", 0, "scope"],
      ["dropped", "mounts", 0, "instructions"],
    ],
  },
  {
    fields: "mounts: [{target: /data, type: 'storage:volume'}]",
    output: { storage: [{ store: "app-web-data", target: "/data" }] },
    diagnostics: [],
  },
  { fields: "mount: ['./a:/b']", output: { mounts: [{ source: "./a", target: "/b" }] }, diagnostics: [] },
  {
    fields: "storage: [{dest: /x}]",
    output: { storage: [{ store: "app-web-x", target: "/x" }] },
    diagnostics: [],
  },
  {
    fields: "storage: [{destination: /x, scope: project}]",
    output: { storage: [{ store: "app-x", target: "/x", scope: "app" }] },
    diagnostics: [["rewritten", "storage", 0, "scope"]],
  },
  { fields: "endpoints: [8080/http]", output: {}, diagnostics: [["dropped", "endpoints"]] },
])("emits schema-valid mount fidelity for $fields", async ({ fields, output, diagnostics }) => {
  // Given / When
  const result = await translate(yaml(fields));
  // Then
  expect(result.outputs).toHaveLength(1);
  for (const { fragment } of result.outputs)
    expect(decode(fragment)).toMatchObject({ services: { web: output } });
  expect(result.diagnostics.map((entry) => [entry.kind, ...entry.keyPath.slice(2)])).toEqual([
    ["rewritten", "home"],
    ...diagnostics.map((entry) => [...entry]),
  ]);
});

test("reports local mount drops at authored indexes after base mount concatenation", async () => {
  // Given
  const base = yaml("mounts: ['./a:/a', './b:/b']");
  const local = "services: {web: {mounts: [{source: ./c, target: /c, owner: www-data}]}}";
  // When
  const result = await translate(base, local);
  // Then
  expect(result.outputs).toHaveLength(2);
  for (const { fragment } of result.outputs) decode(fragment);
  expect(result.outputs[1]?.fragment).toMatchObject({
    services: {
      web: {
        mounts: [
          { source: "./a", target: "/a" },
          { source: "./b", target: "/b" },
          { source: "./c", target: "/c" },
        ],
      },
    },
  });
  expect(result.diagnostics.filter((entry) => entry.kind === "dropped")).toMatchObject([
    {
      kind: "dropped",
      sourceId: ".lando.local.yml",
      keyPath: ["services", "web", "mounts", 0, "owner"],
      span: expect.anything(),
    },
  ]);
});

test("honors app alias precedence split across two layers", async () => {
  // Given
  const base = yaml("appMount: /base");
  const local = "services: {web: {appmount: /middle, app-mount: /local}}";
  // When
  const result = await translate(base, local);
  // Then
  expect(result.outputs).toHaveLength(2);
  for (const { fragment } of result.outputs) decode(fragment);
  expect(result.outputs[0]?.fragment).toMatchObject({ services: { web: { appMount: { target: "/base" } } } });
  expect(result.outputs[1]?.fragment).toEqual({});
  expect(
    result.diagnostics
      .filter((entry) => entry.kind === "dropped")
      .map((entry) => [String(entry.sourceId), entry.kind, entry.keyPath]),
  ).toEqual([
    [".lando.local.yml", "dropped", ["services", "web", "appmount"]],
    [".lando.local.yml", "dropped", ["services", "web", "app-mount"]],
  ]);
});

test("keeps specific lowerer diagnostics ahead of generic unknown key drops", async () => {
  // Given / When
  const result = await translate(yaml("mounts: [{source: ./a, target: /b, consistency: cached}]"));
  // Then
  expect(result.outputs).toHaveLength(1);
  for (const { fragment } of result.outputs) decode(fragment);
  const drops = result.diagnostics.filter((entry) => entry.kind === "dropped");
  expect(drops).toHaveLength(1);
  expect(drops[0]?.keyPath).toEqual(["services", "web", "mounts", 0, "consistency"]);
  expect(drops[0]?.message).toContain("no equivalent on this Lando 4 mount");
});
