import { expect, test } from "bun:test";
import {
  GlobalConfig,
  getJsonSchema,
  getJsonSchemaWithDeprecations,
  renderSchemaReferenceMarkdown,
  withDefaultKey,
} from "@lando/sdk/schema";
import { Schema } from "effect";

test("decodes and encodes defaults while publishing them in JSON Schema", () => {
  const sample = Schema.Struct({ enabled: Schema.Boolean.pipe(withDefaultKey(true)) });
  const decoded = Schema.decodeUnknownSync(sample)({});
  expect(decoded).toEqual({ enabled: true });
  expect(Schema.encodeSync(sample)(decoded)).toEqual({ enabled: true });
  expect(getJsonSchemaWithDeprecations(sample)).toMatchObject({
    properties: { enabled: { type: "boolean", allOf: [{ default: true }] } },
  });
});

test("preserves explicit values and validates them with the original checks", () => {
  const sample = Schema.Struct({ count: Schema.Number.check(Schema.isInt()).pipe(withDefaultKey(15)) });
  expect(Schema.decodeUnknownSync(sample)({ count: 1 })).toEqual({ count: 1 });
  expect(() => Schema.decodeUnknownSync(sample)({ count: 1.5 })).toThrow();
});

test("clones mutable defaults separately for every decode", () => {
  const sample = Schema.Struct({
    tags: Schema.mutable(Schema.Array(Schema.String)).pipe(withDefaultKey([])),
  });
  const decode = Schema.decodeUnknownSync(sample);
  const first = decode({});
  first.tags.push("first");
  expect(decode({})).toEqual({ tags: [] });
});

test("publishes reachable host defaults without changing decoded values", () => {
  expect(getJsonSchema("GlobalConfig")).toMatchObject({
    properties: {
      allowLoadOutsideRoot: { allOf: [{ default: false }] },
      loadMaxFileBytes: { allOf: [{ default: 1_048_576 }] },
      telemetry: { allOf: [{ default: { enabled: true } }] },
      notify: {
        properties: {
          enabled: { allOf: [{ default: true }] },
          thresholdMs: { allOf: [{ default: 15_000 }] },
          commands: { allOf: [{ default: [] }] },
        },
      },
    },
  });
  expect(
    Schema.decodeUnknownSync(GlobalConfig)({ notify: {}, network: { proxy: {}, ca: {} }, proxy: {} }),
  ).toMatchObject({
    telemetry: { enabled: true },
    notify: { enabled: true, thresholdMs: 15_000, commands: [] },
    network: {
      proxy: { noProxy: [], injectIntoServices: false },
      ca: { trustHost: true, certs: [], injectIntoServices: true },
    },
    proxy: { defaultDomain: "lndo.site" },
  });
});

test("publishes log-source defaults through the authored Landofile schema", () => {
  expect(getJsonSchema("LandofileShape")).toMatchObject({
    $defs: {
      LogSourceInput: {
        properties: {
          stream: { allOf: [{ default: "stderr" }] },
          timestamps: { allOf: [{ default: false }] },
        },
      },
    },
  });
});

test("renders annotation-only allOf defaults in the reference Default column", () => {
  const sample = Schema.Struct({ enabled: Schema.Boolean.pipe(withDefaultKey(true)) });
  expect(renderSchemaReferenceMarkdown("DefaultKeySample", sample)).toMatch(
    /\| `enabled` \| No \| `boolean` \|[^|]*\| `true` \|/,
  );
});
