import { expect, test } from "bun:test";
import { LandofileAuthoringShape } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Schema } from "effect";
import { lowerCatalogCommon } from "../src/lower-catalog-common.ts";
import { lowerPhpOptions } from "../src/lower-php.ts";
import { type ServiceLoweringContext, mergePatches } from "../src/lowering-contract.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

const ctx: ServiceLoweringContext = {
  serviceName: "app",
  keyPath: ["services", "app"],
  fallbackSourceId: "base",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const diagnostic = (kind: string, ...relative: string[]) => ({
  kind,
  keyPath: [...ctx.keyPath, ...relative],
});
const locations = (result: {
  readonly diagnostics: readonly { readonly kind: string; readonly keyPath: readonly (string | number)[] }[];
}) => result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }));

test.each([256, "256"])("rewrites memcached memory when mem is %j", (mem) => {
  // Given / When
  const result = lowerCatalogCommon({ type: "memcached", mem, port: "11212" }, ctx);
  // Then
  expect(result.patch).toEqual({
    type: "memcached",
    port: 11212,
    command: ["memcached", "-p", "11212", "-m", "256"],
  });
  expect(locations(result)).toEqual([diagnostic("rewritten", "mem")]);
});
test.each(["128m", false, null, {}])("drops invalid memcached memory %j", (mem) => {
  // Given / When
  const result = lowerCatalogCommon({ type: "memcached", mem }, ctx);
  // Then
  expect(result.patch).toEqual({ type: "memcached" });
  expect(locations(result)).toEqual([diagnostic("dropped", "mem")]);
  expect(result.diagnostics[0]?.remediation).toMatch(/\S/u);
});
test("uses the default memcached port when none is authored", () => {
  // Given / When
  const result = lowerCatalogCommon({ type: "memcached", mem: 128 }, ctx);
  // Then
  expect(result.patch).toEqual({ type: "memcached", command: ["memcached", "-p", "11211", "-m", "128"] });
});
test("keeps authored memcached command when mem also exists", () => {
  // Given / When
  const result = lowerCatalogCommon({ type: "memcached", mem: 128, command: ["custom"] }, ctx);
  // Then
  expect(result.patch).toEqual({ type: "memcached", command: ["custom"] });
  expect(locations(result)).toEqual([diagnostic("dropped", "mem")]);
  expect(result.diagnostics[0]?.remediation).toContain("add -m 128 to command");
});
for (const [type, variable] of [
  ["elasticsearch:8", "ES_JAVA_OPTS"],
  ["opensearch:2", "OPENSEARCH_JAVA_OPTS"],
] as const) {
  test.each(["1024m", "2G", "512k"])(`rewrites ${type} heap when mem is %s`, (mem) => {
    // Given / When
    const result = lowerCatalogCommon({ type, mem, environment: ["KEEP=yes"] }, ctx);
    // Then
    expect(result.patch).toEqual({ type, environment: { KEEP: "yes", [variable]: `-Xms${mem} -Xmx${mem}` } });
    expect(locations(result)).toEqual([diagnostic("rewritten", "mem")]);
  });
  test.each([{ environment: { [variable]: "custom" } }, { environment: [`${variable}=custom`] }])(
    `keeps authored ${variable} when mem exists`,
    ({ environment }) => {
      // Given / When
      const result = lowerCatalogCommon({ type, mem: "2g", environment }, ctx);
      // Then
      expect(result.patch).toEqual({ type, environment: { [variable]: "custom" } });
      expect(locations(result)).toEqual([diagnostic("dropped", "mem")]);
    },
  );
  test.each([1024, "1024", "1.5g", false])(`drops invalid ${type} heap %j`, (mem) => {
    // Given / When
    const result = lowerCatalogCommon({ type, mem }, ctx);
    // Then
    expect(result.patch).toEqual({ type });
    expect(locations(result)).toEqual([diagnostic("dropped", "mem")]);
  });
  test(`blocks ${type} when plugins are authored`, () => {
    // Given / When
    const result = lowerCatalogCommon({ type, plugins: ["analysis-icu", "analysis-phonetic"] }, ctx);
    // Then
    expect(result.blocked).toBe(true);
    expect(locations(result)).toEqual([diagnostic("unsupported", "plugins")]);
    const id = type.startsWith("opensearch") ? "opensearch" : "elasticsearch";
    expect(result.diagnostics[0]?.message).toBe(`Lando 4 cannot install ${id} plugins.`);
  });
}
test.each([true, false, "trigger"])("drops Xdebug request setting %j and maps the port", (start) => {
  // Given
  const service = {
    type: "php:8.3",
    environment: ["KEEP=yes"],
    xdebug: { mode: "debug", start_with_request: start, client_port: "9005" },
  };
  // When
  const result = mergePatches(lowerCatalogCommon(service, ctx), lowerPhpOptions(service, ctx));
  // Then
  expect(result.patch).toEqual({
    type: "php:8.3",
    xdebug: "debug",
    environment: {
      KEEP: "yes",
      XDEBUG_CONFIG: "client_host=host.docker.internal client_port=9005",
    },
  });
  expect(locations(result)).toEqual([
    diagnostic("needs-review", "type"),
    diagnostic("rewritten", "xdebug"),
    diagnostic("dropped", "xdebug", "start_with_request"),
    diagnostic("rewritten", "xdebug", "client_port"),
  ]);
});
test.each([{ environment: { XDEBUG_CONFIG: "custom" } }, { environment: ["XDEBUG_CONFIG=custom"] }])(
  "preserves authored Xdebug config %j",
  ({ environment }) => {
    // Given
    const service = { type: "php:8.3", environment, xdebug: { start_with_request: true, client_port: 9010 } };
    // When
    const result = mergePatches(lowerCatalogCommon(service, ctx), lowerPhpOptions(service, ctx));
    // Then
    expect(result.patch).toEqual({ type: "php:8.3", xdebug: true, environment: { XDEBUG_CONFIG: "custom" } });
    expect(locations(result)).toEqual([
      diagnostic("needs-review", "type"),
      diagnostic("rewritten", "xdebug"),
      diagnostic("dropped", "xdebug", "start_with_request"),
      diagnostic("dropped", "xdebug", "client_port"),
    ]);
  },
);
test("drops invalid Xdebug values and each ini key without retaining an object", () => {
  // Given / When
  const result = lowerPhpOptions(
    { xdebug: { start_with_request: [], client_port: "bad", config: { one: 1, two: 2 }, other: true } },
    ctx,
  );
  // Then
  expect(result.patch).toEqual({ xdebug: true });
  expect(locations(result)).toEqual([
    diagnostic("needs-review", "type"),
    diagnostic("rewritten", "xdebug"),
    diagnostic("dropped", "xdebug", "start_with_request"),
    diagnostic("dropped", "xdebug", "client_port"),
    diagnostic("dropped", "xdebug", "config", "one"),
    diagnostic("dropped", "xdebug", "config", "two"),
    diagnostic("dropped", "xdebug", "other"),
  ]);
});
test("does not invent XDEBUG_CONFIG when only start_with_request is authored", () => {
  // Given / When
  const result = lowerPhpOptions({ xdebug: { start_with_request: false, config: "bad" } }, ctx);
  // Then
  expect(result.patch).toEqual({ xdebug: true });
  expect(locations(result)).toEqual([
    diagnostic("needs-review", "type"),
    diagnostic("rewritten", "xdebug"),
    diagnostic("dropped", "xdebug", "start_with_request"),
    diagnostic("dropped", "xdebug", "config"),
  ]);
});
test.each(["elasticsearch:8", "opensearch:2"])(
  "clears translation output when %s requests plugins",
  async (type) => {
    // Given
    const translator = makeLando3ConfigTranslator({
      decomposers: fakeDecomposers().decomposers,
      redactor: createRedactor("secrets"),
    });
    const input = documentSet([
      document(".lando.yml", `services: {app: {type: ${type}, plugins: [analysis-icu]}}`),
    ]);
    // When
    const result = await Effect.runPromise(translator.translate(input));
    // Then
    expect(result.outputs).toEqual([]);
    expect(locations(result)).toEqual([diagnostic("unsupported", "plugins")]);
  },
);
test("translates memory and Xdebug targets into a decodable authoring fragment", async () => {
  // Given
  const translator = makeLando3ConfigTranslator({
    decomposers: fakeDecomposers().decomposers,
    redactor: createRedactor("secrets"),
  });
  const input = documentSet([
    document(
      ".lando.yml",
      "services:\n  search: {type: elasticsearch:8, mem: 1024m}\n  cache: {type: memcached, mem: 128}\n  php: {type: php:8.3, xdebug: {client_port: 9005}}\n",
    ),
  ]);
  // When
  const result = await Effect.runPromise(translator.translate(input));
  // Then
  expect(result.outputs).toHaveLength(1);
  const fragment = result.outputs[0]?.fragment;
  expect(fragment).toEqual({
    services: {
      search: { type: "elasticsearch:8", environment: { ES_JAVA_OPTS: "-Xms1024m -Xmx1024m" } },
      cache: { type: "memcached", command: ["memcached", "-p", "11211", "-m", "128"] },
      php: {
        type: "php:8.3",
        xdebug: true,
        environment: { XDEBUG_CONFIG: "client_host=host.docker.internal client_port=9005" },
      },
    },
  });
  expect(() =>
    Schema.decodeUnknownSync(LandofileAuthoringShape, { onExcessProperty: "error" })(fragment),
  ).not.toThrow();
});
