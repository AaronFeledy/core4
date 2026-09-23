import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { mergeLandofiles } from "@lando/landofile/merge";
import { ConfigTranslateInput } from "@lando/sdk/schema";

import { BUNDLED_PLUGIN_MODULES } from "../../src/plugins/generated/bundled.ts";

const digest = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

const document = (path: string, text: string) => ({
  sourceId: path,
  layerId: "canonical" as const,
  path,
  mediaType: "application/yaml",
  contentDigest: digest(text),
  bytes: Buffer.from(text, "utf8").toString("base64"),
});

const asRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected an authoring mapping, received ${JSON.stringify(value)}.`);
  }
  return Object.fromEntries(Object.entries(value));
};

describe("bundled lando3 recipe lowering", () => {
  test("regenerates a structural wordpress option through the real decomposer", async () => {
    const module = BUNDLED_PLUGIN_MODULES.find((entry) => entry.name === "@lando/lando3");
    const translator = await module?.configTranslators?.get("lando3")?.();
    if (translator === undefined) throw new Error("bundled lando3 translator did not load");
    const documents = [
      document(".lando.dist.yml", "recipe: wordpress\nconfig: {redis: true}\n"),
      document(".lando.local.yml", "config: {redis: false}\n"),
    ];
    const input = Schema.decodeUnknownSync(ConfigTranslateInput)({
      _tag: "landofile-document-set",
      documents,
      mode: "full",
      selectedSourceIds: documents.map(({ sourceId }) => sourceId),
      currentLowerV4Fragments: [],
      writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
    });
    const result = await Effect.runPromise(translator.translate(input));
    const merged = mergeLandofiles(result.outputs.map(({ fragment }) => asRecord(fragment)));
    const services = asRecord(merged.services);
    expect(services).not.toHaveProperty("cache");
    expect(asRecord(services.appserver).dependsOn).toEqual(["database"]);
    expect(asRecord(services.database).type).toBe("mariadb");
    expect(asRecord(merged.recipe).options).toMatchObject({ redis: false, php: "8.3" });
    expect(result.outputs.find(({ targetLayer }) => targetLayer === "dist")?.fragment).not.toHaveProperty(
      "services.cache",
    );
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.kind === "needs-review" && diagnostic.keyPath.includes("cache"),
      ),
    ).toBe(true);
  });
});
