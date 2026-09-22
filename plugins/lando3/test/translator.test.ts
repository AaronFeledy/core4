import { describe, expect, test } from "bun:test";
import { ConfigTranslateInput, ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";

import { slugifyAppName } from "../src/naming.ts";
import { lando3ConfigTranslator } from "../src/translator.ts";

const digest = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

const document = (path: string, text: string, mediaType = "application/yaml") => ({
  sourceId: ConfigTranslateSourceId.make(path),
  layerId: "canonical" as const,
  path,
  mediaType,
  contentDigest: digest(text),
  bytes: Buffer.from(text, "utf8").toString("base64"),
});

const translate = (documents: ReadonlyArray<ReturnType<typeof document>>) => {
  const input = Schema.decodeUnknownSync(ConfigTranslateInput)({
    _tag: "landofile-document-set",
    documents,
    mode: "full",
    selectedSourceIds: documents.map((entry) => entry.sourceId),
    currentLowerV4Fragments: [],
    writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
  });
  return Effect.runPromise(Effect.either(lando3ConfigTranslator.translate(input)));
};

describe("lando3 document set", () => {
  test("merges only the seven app-root yml layers", async () => {
    const result = await translate([
      document(".lando.yml", "name: Kitchen Sink\n"),
      document("docker-compose.yml", "services: {web: {image: evil}}\n"),
      document("apps/.lando.yml", "name: nested\n"),
      document(".lando.recipe.yaml", "name: from-yaml\nservices: {web: {image: evil}}\n"),
      document("package.json", '{"name":"pkg"}', "application/json"),
    ]);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.outputs).toEqual([
      {
        targetLayer: "canonical",
        fragment: { name: "kitchen-sink" },
        sourceIds: [ConfigTranslateSourceId.make(".lando.yml")],
      },
    ]);
    expect(result.right.diagnostics).toEqual([]);
  });

  test("does not fail conversion when an unrelated file is malformed", async () => {
    const result = await translate([
      document(".lando.yml", "name: Kitchen Sink\n"),
      document("docker-compose.yml", "services: [\n"),
    ]);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    expect(result.right.outputs[0]?.fragment).toEqual({ name: "kitchen-sink" });
  });

  test("names configured custom basenames without reading them", async () => {
    const result = await translate([
      document(
        ".lando.yml",
        [
          "name: app",
          "landoFile: custom.yml",
          "preLandoFiles:",
          "  - before.yml",
          "postLandoFiles: after.yml",
          "",
        ].join("\n"),
      ),
    ]);
    expect(result._tag).toBe("Right");
    if (result._tag !== "Right") return;
    const custom = result.right.diagnostics.filter((diagnostic) => diagnostic.kind === "needs-review");
    expect(custom.map((diagnostic) => diagnostic.keyPath)).toEqual([
      ["landoFile"],
      ["preLandoFiles"],
      ["postLandoFiles"],
    ]);
    expect(custom.map((diagnostic) => diagnostic.message).join("\n")).toContain("custom.yml");
    expect(custom.map((diagnostic) => diagnostic.message).join("\n")).toContain("before.yml");
    expect(custom.map((diagnostic) => diagnostic.message).join("\n")).toContain("after.yml");
  });

  test("omits source text from a parse failure", async () => {
    const secret = "canary-secret-value";
    const result = await translate([document(".lando.yml", `name: app\n${secret}: 1\n${secret}: 2\n`)]);
    expect(result._tag).toBe("Left");
    if (result._tag !== "Left") return;
    expect(result.left.message).not.toContain(secret);
    expect(result.left.message).toContain(".lando.yml");
  });
});

describe("slugifyAppName", () => {
  test("matches slugify strict lower for the corpus name and folded letters", () => {
    expect(slugifyAppName("ландоьслуггы | Lando-Sluggy")).toBe("landosluggy-or-lando-sluggy");
    expect(slugifyAppName("Straße")).toBe("strasse");
    expect(slugifyAppName("smør")).toBe("smor");
    expect(slugifyAppName("café")).toBe("cafe");
    expect(slugifyAppName("My App!")).toBe("my-app");
    expect(slugifyAppName("lando-restart")).toBe("lando-restart");
  });
});
