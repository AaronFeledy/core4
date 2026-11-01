import { expect, test } from "bun:test";
import { parseLegacyLandofile } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId, LandofileAuthoringFragment } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { mergeLegacySources, occurrencesAt, toMergedValue } from "../src/legacy-merge.ts";
import { droppedServiceKey } from "../src/service-diagnostics.ts";
import { document, documentSet } from "./fixtures/fake-decomposers.ts";
import { makeTestTranslator } from "./fixtures/test-ports.ts";

const translate = async (...texts: readonly string[]) => {
  const translator = makeTestTranslator();
  const input = documentSet(
    texts.map((text, index) => ({
      ...document(index === 0 ? ".lando.yml" : ".lando.local.yml", text),
      layerId: index === 0 ? "canonical" : "local",
    })),
  );
  const result = await Effect.runPromise(translator.translate(input));
  for (const { fragment } of result.outputs)
    Schema.decodeUnknownSync(LandofileAuthoringFragment, { onExcessProperty: "error" })(fragment);
  return result;
};
const api4 = (fields: string) => `services: {web: {api: 4, type: lando, image: 'alpine:3.21', ${fields}}}`;

test("uses exact authored paths when a mapping follows a mount array", () => {
  // Given
  const base = api4("mounts: ['./a:/a']");
  const local = "services: {web: {mounts: {owner: www-data}}}";
  const merged = mergeLegacySources(
    [base, local].map((content, index) => {
      const layer = index === 0 ? "canonical" : "local";
      const file = index === 0 ? ".lando.yml" : ".lando.local.yml";
      const sourceId = ConfigTranslateSourceId.make(file);
      const parsed = Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content }));
      return { file, sourceId, layer, value: toMergedValue({ document: parsed, sourceId, layer }) };
    }),
  );
  // When
  const diagnostic = droppedServiceKey({
    ctx: {
      serviceFacts: {},
      serviceName: "web",
      keyPath: ["services", "web"],
      fallbackSourceId: ".lando.local.yml",
      occurrenceAt: (relative) => occurrencesAt(merged, ["services", "web", ...relative]).at(-1),
      topLevel: { excludes: [], includes: [] },
    },
    relative: ["mounts", 1, "owner"],
    message: "Unsupported ownership",
    remediation: "Remove owner",
  });
  // Then
  expect(diagnostic).toMatchObject({
    kind: "dropped",
    sourceId: ".lando.local.yml",
    keyPath: ["services", "web", "mounts", "owner"],
    span: expect.anything(),
  });
});

test("deduplicates unknown mount keys at their local authored index", async () => {
  // Given
  const base = api4("mounts: ['./a:/a', './b:/b']");
  const local = "services: {web: {mounts: [{source: ./c, target: /c, consistency: cached}]}}";
  // When
  const result = await translate(base, local);
  // Then
  expect(result.diagnostics.filter(({ kind }) => kind === "dropped")).toEqual([
    expect.objectContaining({
      sourceId: ".lando.local.yml",
      keyPath: ["services", "web", "mounts", 0, "consistency"],
      span: expect.anything(),
    }),
  ]);
});

test("locates inherited list listener assignments in their authored source", async () => {
  // Given
  const base = 'services: {db: {type: postgres:16, overrides: {environment: ["PGPORT=5433"]}}}';
  const local = "services: {db: {portforward: true}}";
  // When
  const result = await translate(base, local);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.db.port", 5433);
  expect(result.outputs[1]?.fragment).toHaveProperty("services.db.ports", ["5433"]);
  expect(
    result.diagnostics.filter(
      ({ kind, keyPath }) => kind === "needs-review" && keyPath.includes("environment"),
    ),
  ).toEqual([
    expect.objectContaining({
      sourceId: ".lando.yml",
      keyPath: ["services", "db", "overrides", "environment", 0],
      span: expect.anything(),
    }),
  ]);
});

test("rebinds top-level includes read-write beneath read-only string app mounts", async () => {
  // Given
  const text = `excludes: [cache, "!cache/keep"]\n${api4("app-mount: '/site:ro'")}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.appMount", {
    target: "/site",
    readOnly: true,
    excludes: ["cache"],
  });
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.mounts", [
    { source: "./cache/keep", target: "/site/cache/keep" },
  ]);
});

test("normalizes top-level masks on the implicit API-4 app mount", async () => {
  // Given
  const text = `excludes: [/cache, "!/cache/keep"]\n${api4("")}`;
  // When
  const result = await translate(text);
  // Then
  expect(result.outputs[0]?.fragment).toHaveProperty("services.web.appMount", {
    target: "/app",
    excludes: ["cache"],
    includes: ["cache/keep"],
  });
});

test.each(["cache/*", "cache/?", "cache/[ab]", "//absolute", "cache/../secret"])(
  "drops invalid include path %s at each authored entry",
  async (path) => {
    // Given
    const text = `excludes: [${JSON.stringify(`!${path}`)}]\n${api4(
      `app-mount: '/site:ro', mounts: [
        {source: '.', target: /root, excludes: [${JSON.stringify(`!${path}`)}]},
        {source: ./other, target: /other, excludes: [${JSON.stringify(`!${path}`)}]},
        {type: copy, source: '.', target: /copy, includes: [${JSON.stringify(path)}]},
        {type: copy, source: ./other, target: /copy-other, include: ${JSON.stringify(path)}}]`,
    )}`;
    // When
    const result = await translate(text);
    // Then
    expect(result.outputs[0]?.fragment).toHaveProperty("services.web.appMount", {
      target: "/site",
      readOnly: true,
    });
    expect(result.outputs[0]?.fragment).toHaveProperty("services.web.mounts", [
      { source: ".", target: "/root" },
      { source: "./other", target: "/other" },
      { source: ".", target: "/copy" },
      { source: "./other", target: "/copy-other" },
    ]);
    const drops = result.diagnostics.filter(
      ({ kind, keyPath }) => kind === "dropped" && keyPath.at(-1) !== "type",
    );
    expect(drops.map(({ keyPath }) => keyPath)).toEqual([
      ["excludes", 0],
      ["services", "web", "mounts", 0, "excludes", 0],
      ["services", "web", "mounts", 1, "excludes", 0],
      ["services", "web", "mounts", 2, "includes", 0],
      ["services", "web", "mounts", 3, "include"],
    ]);
    expect(drops.every(({ sourceId, span }) => sourceId === ".lando.yml" && span !== undefined)).toBe(true);
    for (const drop of drops) {
      expect(drop.message).toContain("literal host path");
      expect(drop.message).toContain("literal relative paths");
    }
  },
);
