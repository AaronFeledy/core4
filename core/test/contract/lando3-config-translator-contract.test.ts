import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import * as lando3 from "@lando/lando3";
import { ConfigTranslateDetectInput, ConfigTranslateInput } from "@lando/sdk/schema";
import type { ConfigTranslatorShape } from "@lando/sdk/services";
import { type ConfigTranslatorContractHarness, runConfigTranslatorContractSuite } from "@lando/sdk/test";

const digest = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

const document = (sourceId: string, path: string, text: string) => ({
  sourceId,
  layerId: "canonical",
  path,
  mediaType: "application/yaml",
  contentDigest: digest(text),
  bytes: Buffer.from(text, "utf8").toString("base64"),
});

/** Name only: every other section still reports `unsupported`, which would block a write. */
const NAME_ONLY = "name: Contract App\n";

const LANDO3_APP = ["name: legacy-app", "recipe: drupal10", "config:", "  php: '8.3'", ""].join("\n");

const LANDO4_APP = ["runtime: 4", "name: modern-app", "services:", "  web:", "    type: 'php:8.4'", ""].join(
  "\n",
);

const translateInput = Schema.decodeUnknownSync(ConfigTranslateInput)({
  _tag: "landofile-document-set",
  documents: [document("app:.lando.yml", "/app/.lando.yml", NAME_ONLY)],
  mode: "full",
  selectedSourceIds: ["app:.lando.yml"],
  currentLowerV4Fragments: [],
  writableLayerIds: ["base", "dist", "upstream", "canonical", "local", "user"],
});

const detectInput = Schema.decodeUnknownSync(ConfigTranslateDetectInput)({
  documents: [document("legacy:.lando.yml", "/legacy/.lando.yml", LANDO3_APP)],
});

const nonMatchingDetectInput = Schema.decodeUnknownSync(ConfigTranslateDetectInput)({
  documents: [document("modern:.lando.yml", "/modern/.lando.yml", LANDO4_APP)],
});

/** Resolve the translator exactly as the plugin graph does, through the lazy loader. */
const loadBundledTranslator = async (): Promise<ConfigTranslatorShape> => {
  const loader = lando3.plugin.configTranslators?.get(lando3.LANDO3_TRANSLATOR_ID);
  if (loader === undefined) throw new Error("@lando/lando3 must contribute the lando3 translator.");
  return await loader();
};

describe("ConfigTranslator contract — bundled lando3", () => {
  test("the bundled lando3 translator passes the contract suite", async () => {
    const translator = await loadBundledTranslator();
    expect(translator.id).toBe("lando3");
    expect(translator.encode).toBeUndefined();
    const harness: ConfigTranslatorContractHarness = {
      name: "lando3",
      translator,
      translateInput,
      detectInput,
      nonMatchingDetectInput,
    };
    const exit = await Effect.runPromiseExit(runConfigTranslatorContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("the manifest contribution and the lazy loader agree on the translator id", () => {
    const declared = lando3.plugin.manifest.contributes?.configTranslators?.map(({ id }) => id) ?? [];
    expect(declared).toEqual(["lando3"]);
    expect([...(lando3.plugin.configTranslators?.keys() ?? [])]).toEqual(declared);
  });

  test("the scaffold contributes no doctor check", () => {
    expect(lando3.plugin.doctorChecks).toBeUndefined();
  });

  test("an injected port set reaches the translator the loader builds", async () => {
    let redacted = 0;
    const injected = lando3.makeLando3Plugin({
      decomposers: new Map(),
      redactor: {
        redactString: (text: string) => {
          redacted += 1;
          return text;
        },
        redactValue: (value: unknown) => value,
      },
    });
    const loader = injected.configTranslators?.get(lando3.LANDO3_TRANSLATOR_ID);
    expect(loader).toBeDefined();
    const translator = await loader?.();
    expect(translator?.id).toBe("lando3");

    const broken = Schema.decodeUnknownSync(ConfigTranslateInput)({
      _tag: "landofile-document-set",
      documents: [document("app:.lando.yml", "/app/.lando.yml", "name: a\n\tbad: 1\n")],
      mode: "full",
      selectedSourceIds: ["app:.lando.yml"],
      currentLowerV4Fragments: [],
      writableLayerIds: ["canonical"],
    });
    const exit = await Effect.runPromiseExit(translator?.translate(broken) ?? Effect.void);
    expect(exit._tag).toBe("Failure");
    expect(redacted).toBeGreaterThan(0);
  });
});
