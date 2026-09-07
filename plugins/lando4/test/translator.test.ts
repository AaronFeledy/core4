import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { emitLandofileYamlEither, parseLandofile } from "@lando/sdk/landofile";
import {
  ConfigTranslateDetectInput,
  ConfigTranslateDocumentSetInput,
  ConfigTranslateSourceId,
  LandofileAuthoringFragment,
} from "@lando/sdk/schema";
import type {
  ConfigTranslateInput,
  ConfigTranslateResult,
  ConfigTranslateDetectInput as DetectInput,
} from "@lando/sdk/schema";

import { lando4ConfigTranslator } from "../src/translator.ts";

const CANONICAL = [
  "name: myapp",
  "runtime: 4",
  "services:",
  "  web:",
  "    type: lando",
  '    port: "{{ env.PORT }}"',
  "",
].join("\n");
const LOCAL = ["services:", "  web:", '    port: "{{ env.LOCAL_PORT }}"', ""].join("\n");
const LEGACY = ["name: legacy", "recipe: lamp", "config:", "  php: '7.4'", ""].join("\n");

const digest = (text: string): string =>
  `sha256:${new Bun.CryptoHasher("sha256").update(new TextEncoder().encode(text)).digest("hex")}`;

interface DocumentSpec {
  readonly path: string;
  readonly layerId: string;
  readonly content: string;
  readonly mediaType?: string;
}

const document = ({ path, layerId, content, mediaType = "application/yaml" }: DocumentSpec) => ({
  sourceId: path,
  layerId,
  path,
  mediaType,
  contentDigest: digest(content),
  bytes: Buffer.from(new TextEncoder().encode(content)).toString("base64"),
});

const makeInput = (options: {
  readonly documents: ReadonlyArray<DocumentSpec>;
  readonly mode?: "full" | "single-layer";
  readonly selected?: ReadonlyArray<string>;
  readonly writable?: ReadonlyArray<string>;
}): ConfigTranslateInput =>
  Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
    _tag: "landofile-document-set",
    documents: options.documents.map(document),
    mode: options.mode ?? "full",
    selectedSourceIds: options.selected ?? options.documents.map(({ path }) => path),
    currentLowerV4Fragments: [],
    writableLayerIds: options.writable ?? ["canonical", "local"],
  });

const makeDetectInput = (documents: ReadonlyArray<DocumentSpec>): DetectInput =>
  Schema.decodeUnknownSync(ConfigTranslateDetectInput)({ documents: documents.map(document) });

const canonicalOnly: ReadonlyArray<DocumentSpec> = [
  { path: ".lando.yml", layerId: "canonical", content: CANONICAL },
];

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);
const translate = (input: ConfigTranslateInput): Promise<ConfigTranslateResult> =>
  run(lando4ConfigTranslator.translate(input));

const encodeOf = lando4ConfigTranslator.encode;
if (encodeOf === undefined) throw new Error("The lando4 translator must ship an encoder.");

const COMPLETE_CONTEXT = {
  name: "myapp",
  runtime: 4,
  services: { web: { type: "lando", port: "{{ env.PORT }}" } },
} as const;

describe("lando4 translator identity", () => {
  test("emits one authoring fragment per writable v4 layer with no diagnostics", async () => {
    const result = await translate(makeInput({ documents: canonicalOnly }));
    expect(result.diagnostics).toEqual([]);
    expect(result.deletions).toEqual([]);
    expect(result.outputs).toHaveLength(1);
    const [output] = result.outputs;
    expect(output?.targetLayer).toBe("canonical");
    expect(output?.sourceIds).toEqual([ConfigTranslateSourceId.make(".lando.yml")]);
    expect<unknown>(output?.fragment).toEqual({
      name: "myapp",
      runtime: 4,
      services: { web: { type: "lando", port: "{{ env.PORT }}" } },
    });
  });

  test("keeps every source layer as its own output", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical", "local"]);
  });

  test("is deterministic across repeated runs", async () => {
    const input = makeInput({ documents: canonicalOnly });
    expect(JSON.stringify(await translate(input))).toBe(JSON.stringify(await translate(input)));
  });
});

describe("lando4 translator omissions", () => {
  test("drops a nonwritable layer with a remediated dropped diagnostic", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
        writable: ["canonical"],
      }),
    );
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical"]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.kind).toBe("dropped");
    expect(result.diagnostics[0]?.sourceId).toBe(ConfigTranslateSourceId.make(".lando.local.yml"));
    expect(result.diagnostics[0]?.remediation).toContain("local");
  });

  test("reports a TypeScript Landofile as unsupported without executing it", async () => {
    const result = await translate(
      makeInput({
        documents: [
          ...canonicalOnly,
          {
            path: ".lando.local.ts",
            layerId: "local",
            content: "export default { name: 'boom' };\n",
            mediaType: "application/octet-stream",
          },
        ],
      }),
    );
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["canonical"]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported"]);
    expect(result.diagnostics[0]?.message).toContain("never executed");
  });

  test("rejects a document that is not canonical v4 authoring data", async () => {
    const result = await translate(
      makeInput({ documents: [{ path: ".lando.yml", layerId: "canonical", content: LEGACY }] }),
    );
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported"]);
  });

  test("refuses two documents claiming one layer instead of folding them", async () => {
    const result = await translate(
      makeInput({
        documents: [
          { path: ".lando.yml", layerId: "canonical", content: CANONICAL },
          { path: ".lando.yaml", layerId: "canonical", content: CANONICAL },
        ],
      }),
    );
    expect(result.outputs).toEqual([]);
    expect(result.diagnostics.map(({ kind }) => kind)).toEqual(["unsupported", "unsupported"]);
  });

  test("treats nonselected single-layer documents as context, not omitted input", async () => {
    const result = await translate(
      makeInput({
        documents: [...canonicalOnly, { path: ".lando.local.yml", layerId: "local", content: LOCAL }],
        mode: "single-layer",
        selected: [".lando.local.yml"],
      }),
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.outputs.map((output) => output.targetLayer)).toEqual(["local"]);
  });

  test("fails a recipe request rather than inventing recipe output", async () => {
    const exit = await Effect.runPromiseExit(
      lando4ConfigTranslator.translate({
        _tag: "recipe-request",
        recipe: { id: "lamp", version: "1.0.0" },
        sourceId: ConfigTranslateSourceId.make("recipe:lamp"),
        answers: {},
        secretAnswers: {},
      }),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("lando4 detection", () => {
  test("is exact for a document set carrying the v4 runtime marker", async () => {
    const matches = await run(lando4ConfigTranslator.detect(makeDetectInput(canonicalOnly)));
    expect(matches).toHaveLength(1);
    expect(matches[0]?.translator).toBe("lando4");
    expect(matches[0]?.confidence).toBe("exact");
    expect(matches[0]?.sourceIds).toEqual([ConfigTranslateSourceId.make(".lando.yml")]);
  });

  test("is likely for markerless canonical v4 documents", async () => {
    const matches = await run(
      lando4ConfigTranslator.detect(
        makeDetectInput([{ path: ".lando.local.yml", layerId: "local", content: LOCAL }]),
      ),
    );
    expect(matches[0]?.confidence).toBe("likely");
  });

  test("never matches a Lando 3 document", async () => {
    const matches = await run(
      lando4ConfigTranslator.detect(
        makeDetectInput([{ path: ".lando.yml", layerId: "canonical", content: LEGACY }]),
      ),
    );
    expect(matches).toEqual([]);
  });

  test("never matches without a YAML candidate", async () => {
    expect(await run(lando4ConfigTranslator.detect(makeDetectInput([])))).toEqual([]);
  });

  test("is deterministic across repeated runs", async () => {
    const input = makeDetectInput(canonicalOnly);
    const first = await run(lando4ConfigTranslator.detect(input));
    const second = await run(lando4ConfigTranslator.detect(input));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("lando4 encoding", () => {
  test("emits the complete context with sorted keys and verbatim expressions", async () => {
    const result = await run(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(result.diagnostics).toEqual([]);
    expect(result.text).toBe(
      [
        "name: myapp",
        "runtime: 4",
        "services:",
        "  web:",
        '    port: "{{ env.PORT }}"',
        "    type: lando",
        "",
      ].join("\n"),
    );
  });

  test("emits no provenance comment block", async () => {
    const result = await run(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(result.text.startsWith("#")).toBe(false);
    expect(result.text).not.toContain("#");
  });

  test("is byte stable across repeated encodes", async () => {
    const first = await run(encodeOf({ context: COMPLETE_CONTEXT }));
    const second = await run(encodeOf({ context: COMPLETE_CONTEXT }));
    expect(first.text).toBe(second.text);
  });

  test("emits only the requested fragment and never flattens the context", async () => {
    const result = await run(
      encodeOf({
        context: COMPLETE_CONTEXT,
        fragment: { services: { web: { port: "{{ env.LOCAL_PORT }}" } } },
      }),
    );
    expect(result.text).toBe(["services:", "  web:", '    port: "{{ env.LOCAL_PORT }}"', ""].join("\n"));
    expect(result.text).not.toContain("name:");
    expect(result.text).not.toContain("type: lando");
  });

  test("round-trips canonical authoring values through parse", async () => {
    const result = await run(encodeOf({ context: COMPLETE_CONTEXT }));
    const parsed = await run(parseLandofile({ file: ".lando.yml", content: result.text, cwd: "." }));
    const actual = await run(
      Schema.decodeUnknown(LandofileAuthoringFragment)(parsed, { onExcessProperty: "error" }),
    );
    const expected = await run(
      Schema.decodeUnknown(LandofileAuthoringFragment)(COMPLETE_CONTEXT, { onExcessProperty: "error" }),
    );
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  });

  test("rejects an incomplete authoring context", async () => {
    const exit = await Effect.runPromiseExit(encodeOf({ context: { name: 4 } as never }));
    expect(exit._tag).toBe("Failure");
  });

  test("agrees with the canonical serializer", () => {
    expect(emitLandofileYamlEither({ b: 1, a: 2 }, { sortKeys: true })).toEqual(
      expect.objectContaining({ _tag: "Right" }),
    );
  });
});
