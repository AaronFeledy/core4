import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { plugin } from "@lando/lando4";
import { ConfigTranslateDetectInput, ConfigTranslateDocumentSetInput } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { type ConfigTranslatorContractHarness, runConfigTranslatorContractSuite } from "@lando/sdk/test";

const CANONICAL = [
  "name: myapp",
  "runtime: 4",
  "services:",
  "  web:",
  "    type: lando",
  '    port: "{{ env.PORT }}"',
  "",
].join("\n");
const FOREIGN = ["name: legacy", "recipe: lamp", "config:", "  php: '7.4'", ""].join("\n");

const snapshot = (path: string, content: string) => {
  const bytes = new TextEncoder().encode(content);
  return {
    sourceId: path,
    layerId: "canonical",
    path,
    mediaType: "application/yaml",
    contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
    bytes: Buffer.from(bytes).toString("base64"),
  };
};

const translateInput = Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
  _tag: "landofile-document-set",
  documents: [snapshot(".lando.yml", CANONICAL)],
  mode: "full",
  selectedSourceIds: [".lando.yml"],
  currentLowerV4Fragments: [],
  writableLayerIds: ["canonical"],
});
const detectInput = Schema.decodeUnknownSync(ConfigTranslateDetectInput)({
  documents: [snapshot(".lando.yml", CANONICAL)],
});
const nonMatchingDetectInput = Schema.decodeUnknownSync(ConfigTranslateDetectInput)({
  documents: [snapshot(".lando.yml", FOREIGN)],
});

const context = {
  name: "myapp",
  runtime: 4,
  services: { web: { type: "lando", port: "{{ env.PORT }}" } },
} as const;

/** Resolve the translator exactly as the plugin graph does, through the lazy loader. */
const loadBundledTranslator = async (): Promise<ConfigTranslatorShape> => {
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("@lando/lando4 must contribute the lando4 translator.");
  return await loader();
};

describe("ConfigTranslator contract — bundled lando4", () => {
  test("the bundled lando4 translator passes the contract suite", async () => {
    const translator = await loadBundledTranslator();
    expect(translator.id).toBe("lando4");
    const harness: ConfigTranslatorContractHarness = {
      name: "lando4",
      translator,
      translateInput,
      detectInput,
      nonMatchingDetectInput,
      encodeSamples: [
        { context },
        { context, fragment: { services: { web: { port: "{{ env.LOCAL_PORT }}" } } } },
      ],
    };
    const exit = await Effect.runPromiseExit(runConfigTranslatorContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("the manifest contribution and the lazy loader agree on the translator id", async () => {
    const declared = plugin.manifest.contributes?.configTranslators?.map(({ id }) => id) ?? [];
    expect(declared).toEqual(["lando4"]);
    expect([...(plugin.configTranslators?.keys() ?? [])]).toEqual(declared);
    expect(declared[0]).toBe("lando4");
    expect((await loadBundledTranslator()).id).toBe("lando4");
  });
});
