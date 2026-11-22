import { expect, test } from "bun:test";
import { GlobalConfig, getEditorJsonSchema, getJsonSchema } from "@lando/sdk/schema";
import { GlobalConfigStandardJSONSchema, GlobalConfigStandardSchema } from "@lando/sdk/schema/standard";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { Arbitrary, Effect, Result, Schema } from "effect";

const options = {
  strict: false,
  validateFormats: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
} as const;
const draft07 = new Ajv(options);
const draft2020 = new Ajv2020(options);
const standard = GlobalConfigStandardJSONSchema["~standard"].jsonSchema;
const validators = {
  editor: draft07.compile(getEditorJsonSchema("GlobalConfig")),
  standard07: draft07.compile(standard.input({ target: "draft-07" })),
  standard2020: draft2020.compile(standard.input({ target: "draft-2020-12" })),
  registered: draft2020.compile(getJsonSchema("GlobalConfig")),
};
const decode = Schema.decodeUnknownResult(GlobalConfig, { onExcessProperty: "error" });
const entries = (count: number, value: string) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`KEY_${index}`, value]));

const cases = [
  { id: "environment: POSIX names only", input: { environment: { "NOT-POSIX": "v" } }, accepted: false },
  {
    id: "environment: exact core-owned name",
    input: { environment: { LANDO_APP_NAME: "v" } },
    accepted: false,
  },
  {
    id: "environment: non-core LANDO prefix",
    input: { environment: { LANDO_MY_FLAG: "v" } },
    accepted: true,
  },
  { id: "environment: 256 properties", input: { environment: entries(256, "v") }, accepted: true },
  { id: "environment: 257 properties", input: { environment: entries(257, "v") }, accepted: false },
  { id: "labels: empty name", input: { labels: { "": "v" } }, accepted: false },
  { id: "labels: equals in name", input: { labels: { "a=b": "v" } }, accepted: false },
  { id: "labels: NUL in name", input: { labels: { "a\0b": "v" } }, accepted: false },
  { id: "labels: reserved prefix", input: { labels: { "dev.lando.foo": "v" } }, accepted: false },
  { id: "labels: 256 properties", input: { labels: entries(256, "v") }, accepted: true },
  { id: "labels: 257 properties", input: { labels: entries(257, "v") }, accepted: false },
  { id: "environment: 32 KiB value", input: { environment: { KEY: "é".repeat(16_384) } }, accepted: true },
  {
    id: "environment: 31 full-size values",
    input: { environment: entries(31, "é".repeat(16_384)) },
    accepted: true,
  },
] as const;

const runtimeOnly = [
  // JSON Schema length counts code points, not UTF-8 bytes.
  { id: "environment: 16,385 two-byte characters", input: { environment: { KEY: "é".repeat(16_385) } } },
  // Every value fits individually; serialization of the map adds bytes for keys and punctuation.
  { id: "environment: 32 full-size values", input: { environment: entries(32, "é".repeat(16_384)) } },
  { id: "labels: 254-byte name", input: { labels: { ["é".repeat(127)]: "v" } } },
  { id: "labels: 4 KiB value exceeded", input: { labels: { label: "é".repeat(2_049) } } },
  { id: "labels: serialized map exceeds 256 KiB", input: { labels: entries(64, "é".repeat(2_048)) } },
] as const;

async function verdicts(input: unknown) {
  return {
    decode: Result.isSuccess(decode(input)),
    standard: "value" in (await GlobalConfigStandardSchema["~standard"].validate(input)),
    editor: validators.editor(input),
    standard07: validators.standard07(input),
    standard2020: validators.standard2020(input),
    registered: validators.registered(input),
  };
}

test.each(cases)("GlobalConfig $id", async ({ input, accepted }) => {
  expect(await verdicts({ serviceDefaults: input })).toEqual({
    decode: accepted,
    standard: accepted,
    editor: accepted,
    standard07: accepted,
    standard2020: accepted,
    registered: accepted,
  });
});

test.each(runtimeOnly)("GlobalConfig runtime-only $id", async ({ input }) => {
  expect(await verdicts({ serviceDefaults: input })).toEqual({
    decode: false,
    standard: false,
    editor: true,
    standard07: true,
    standard2020: true,
    registered: true,
  });
});

test("generated GlobalConfig leaves agree on both sides of strict input validation", async () => {
  // Sample constructive encoded leaves, not the whole config's custom filters and defaults.
  const leaf = Schema.Struct({ loadMaxFileBytes: GlobalConfig.fields.loadMaxFileBytes });
  const samples = await Effect.runPromise(
    Arbitrary.sampleEffect(Arbitrary.schema(Schema.toEncoded(leaf)), { seed: 2199, count: 12 }),
  );
  for (const sample of samples) {
    expect(await verdicts(sample)).toEqual({
      decode: true,
      standard: true,
      editor: true,
      standard07: true,
      standard2020: true,
      registered: true,
    });
  }
});
