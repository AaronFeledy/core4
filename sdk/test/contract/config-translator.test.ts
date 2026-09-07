import { describe, expect, test } from "bun:test";
import { ConfigTranslateError } from "@lando/sdk/errors";
import { emitLandofileYamlEither } from "@lando/sdk/landofile";
import {
  ConfigTranslateDocumentSetInput,
  ConfigTranslateSourceId,
  LandofileAuthoringFragment,
  type LandofileAuthoringFragmentWire,
} from "@lando/sdk/schema";
import type { ConfigTranslateInput, ConfigTranslateResult, ConfigTranslatorShape } from "@lando/sdk/services";
import {
  type ConfigTranslatorContractHarness,
  ContractFailure,
  makeConfigTranslatorContractSuite,
  runConfigTranslatorContractSuite,
} from "@lando/sdk/test";
import { Effect, Match, Schema } from "effect";

const sourceId = ConfigTranslateSourceId.make("docker-compose.yml");
const bytes = new TextEncoder().encode("services:\n  web:\n    image: nginx\n");
const translateInput = Schema.decodeUnknownSync(ConfigTranslateDocumentSetInput)({
  _tag: "landofile-document-set",
  documents: [
    {
      sourceId,
      layerId: "canonical",
      mediaType: "application/yaml",
      contentDigest: `sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`,
      bytes: Buffer.from(bytes).toString("base64"),
    },
  ],
  mode: "full",
  selectedSourceIds: [sourceId],
  currentLowerV4Fragments: [],
  writableLayerIds: ["canonical"],
});
const fragment = { name: "myapp", services: { web: { type: "lando", port: "{{ env.PORT }}" } } } as const;
const expectedResult: ConfigTranslateResult = {
  outputs: [{ targetLayer: "canonical", fragment, sourceIds: [sourceId] }],
  diagnostics: [
    { kind: "generated", sourceId, keyPath: ["services", "web"], message: "Generated web service." },
  ],
  deletions: [],
};
const makeComposeTranslator = ({
  decoder,
}: {
  readonly decoder: (
    bytes: Uint8Array,
  ) => Effect.Effect<typeof LandofileAuthoringFragmentWire.Type, ConfigTranslateError>;
}): ConfigTranslatorShape => ({
  id: "compose",
  summary: "Translate Compose snapshots.",
  inputKinds: ["docker-compose"],
  detect: ({ documents }) =>
    Effect.succeed(
      documents
        .filter((doc) => doc.sourceId === sourceId)
        .map((doc) => ({ translator: "compose", sourceIds: [doc.sourceId], confidence: "exact" as const })),
    ),
  translate: (input) =>
    Match.value(input).pipe(
      Match.tag("recipe-request", () => Effect.succeed(expectedResult)),
      Match.tag("landofile-document-set", ({ documents }) =>
        Effect.gen(function* () {
          const document = documents[0];
          if (!document)
            return yield* Effect.fail(new ConfigTranslateError({ message: "Missing Compose snapshot." }));
          const decoded = yield* decoder(document.bytes);
          return {
            ...expectedResult,
            outputs: [
              { targetLayer: "canonical" as const, fragment: decoded, sourceIds: [document.sourceId] },
            ],
          };
        }),
      ),
      Match.exhaustive,
    ),
  encode: (sample) =>
    Effect.gen(function* () {
      const value = yield* Schema.decodeUnknown(LandofileAuthoringFragment)(
        sample.fragment ?? sample.context,
      );
      const wire = yield* Schema.encode(LandofileAuthoringFragment)(value);
      const record = yield* Schema.decodeUnknown(
        Schema.Record({ key: Schema.String, value: Schema.Unknown }),
      )(wire);
      return { text: yield* emitLandofileYamlEither(record), diagnostics: [] };
    }).pipe(
      Effect.mapError(
        (cause) => new ConfigTranslateError({ message: "Cannot encode authoring sample.", cause }),
      ),
    ),
});
const translator = makeComposeTranslator({
  decoder: (snapshot) => Effect.succeed(new TextDecoder().decode(snapshot).includes("nginx") ? fragment : {}),
});
const harness: ConfigTranslatorContractHarness = {
  translator,
  translateInput,
  expectedResult,
  detectInput: { documents: translateInput.documents },
  nonMatchingDetectInput: { documents: [] },
  encodeSamples: [
    { context: fragment },
    { context: fragment, fragment: { services: { web: { port: "{{ env.PORT }}" } } } },
  ],
};
const run = (overrides: Partial<ConfigTranslatorContractHarness>) =>
  Effect.runPromiseExit(runConfigTranslatorContractSuite({ ...harness, ...overrides }));

describe("ConfigTranslator contract", () => {
  test("succeeds when snapshots and expression samples obey the contract", async () => {
    // Given an injected pure decoder and expression-bearing samples.
    // When the public suite drives the translator.
    const exit = await run({});
    // Then all laws hold.
    expect(exit._tag).toBe("Success");
  });
  test("fails when output provenance names a foreign source", async () => {
    // Given foreign output provenance.
    const bad = {
      ...expectedResult,
      outputs: [
        { targetLayer: "canonical" as const, fragment, sourceIds: [ConfigTranslateSourceId.make("foreign")] },
      ],
    };
    // When the suite validates the result.
    const exit = await run({ translator: { ...translator, translate: () => Effect.succeed(bad) } });
    // Then the contract rejects it.
    expect(exit._tag).toBe("Failure");
  });
  test("fails when an output is AppPlan-shaped", async () => {
    // Given extra runtime-plan keys, retained through structural typing.
    const plan = { name: "myapp", appId: "x", plan: {} };
    // When the suite validates the output.
    const exit = await run({
      translator: {
        ...translator,
        translate: () =>
          Effect.succeed({
            ...expectedResult,
            outputs: [{ targetLayer: "canonical", fragment: plan, sourceIds: [sourceId] }],
          }),
      },
    });
    // Then it rejects runtime intent.
    expect(exit._tag).toBe("Failure");
  });
  test("fails when diagnostics change across identical translations", async () => {
    // Given deterministic fragments but unstable diagnostics.
    let count = 0;
    const flaky = {
      ...translator,
      translate: () =>
        Effect.sync(() => ({
          ...expectedResult,
          diagnostics: [{ kind: "generated" as const, sourceId, keyPath: [], message: String(++count) }],
        })),
    };
    // When the suite replays the translation without an expected-result oracle.
    const { expectedResult: _expected, ...withoutExpected } = harness;
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({ ...withoutExpected, translator: flaky }),
    );
    // Then diagnostic byte instability fails.
    expect(exit._tag).toBe("Failure");
  });
  test.each([undefined, []])("fails when an encoder has no samples: %j", async (encodeSamples) => {
    // Given an encoder without useful law samples.
    const { encodeSamples: _samples, ...withoutSamples } = harness;
    // When the suite runs.
    const exit = await Effect.runPromiseExit(
      runConfigTranslatorContractSuite({
        ...withoutSamples,
        ...(encodeSamples === undefined ? {} : { encodeSamples }),
      }),
    );
    // Then the encoder cannot silently escape verification.
    expect(exit._tag).toBe("Failure");
  });
  test("fails when an encoder replaces an expression with a literal", async () => {
    // Given an encoder that loses unresolved authoring semantics.
    const bad = {
      ...translator,
      encode: () =>
        Effect.succeed({
          text: "name: myapp\nservices:\n  web:\n    type: lando\n    port: 80\n",
          diagnostics: [],
        }),
    };
    // When the round-trip law runs.
    const exit = await run({ translator: bad });
    // Then canonical decoded values differ.
    expect(exit._tag).toBe("Failure");
  });
  test.each([true, false])("recipe deletion=%j obeys its variant policy", async (deletion) => {
    // Given a synthetic recipe source and optional deletion intent.
    const input: ConfigTranslateInput = {
      _tag: "recipe-request",
      recipe: { id: "web", version: "1" },
      sourceId,
      answers: {},
      secretAnswers: {},
    };
    const result = { ...expectedResult, deletions: deletion ? [{ sourceId }] : [] };
    // When the suite validates the recipe result.
    const exit = await run({
      translateInput: input,
      expectedResult: result,
      translator: { ...translator, translate: () => Effect.succeed(result) },
    });
    // Then only the deletion-free result succeeds.
    expect(exit._tag).toBe(deletion ? "Failure" : "Success");
  });
  test("fails when detection names an undeclared source", async () => {
    // Given a match outside the supplied snapshot set.
    const bad = {
      ...translator,
      detect: () =>
        Effect.succeed([
          {
            translator: "compose",
            sourceIds: [ConfigTranslateSourceId.make("foreign")],
            confidence: "exact" as const,
          },
        ]),
    };
    // When detection is checked.
    const exit = await run({ translator: bad });
    // Then provenance is rejected.
    expect(exit._tag).toBe("Failure");
  });
  test("exports the alias and tagged contract failure", () => {
    // Given the public test-kit surface; when inspecting exports; then identity is preserved.
    expect(makeConfigTranslatorContractSuite).toBe(runConfigTranslatorContractSuite);
    expect(ContractFailure).toBeDefined();
  });
});
