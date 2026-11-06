import { expect, test } from "bun:test";
import { describeConfigKey } from "@lando/engine/config-write/key-schema";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { Effect, Layer, Schema } from "effect";
import { formatBugReport } from "../../src/cli/bug-report.ts";
import { appConfigDescribeSpec } from "../../src/cli/command-specs/app/config/describe.ts";
import { metaGlobalConfigDescribeSpec } from "../../src/cli/command-specs/meta/global/config-describe.ts";
import { AppConfigResultSchema } from "../../src/cli/commands/app-config.ts";
import { renderConfigKeyDescription } from "../../src/cli/commands/config-key-render.ts";
import { GlobalConfigResultSchema, describeGlobalConfig } from "../../src/cli/commands/meta/global-config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

test.each([AppConfigResultSchema, GlobalConfigResultSchema])(
  "Landofile result schemas preserve descriptions and reject incomplete describe results",
  async (schema) => {
    const description = await Effect.runPromise(describeConfigKey("app", "services.web.ports"));
    const result = { subcommand: "describe" as const, ...description };
    expect(Schema.decodeUnknownSync(schema)(result)).toEqual(result);
    expect(() => Schema.decodeUnknownSync(schema)({ subcommand: "describe", key: "services" })).toThrow();
  },
);

test.each([appConfigDescribeSpec, metaGlobalConfigDescribeSpec])(
  "dedicated $id runs without app or global services",
  async (spec) => {
    const result = await Effect.runPromise<unknown, Effect.Error<ReturnType<typeof describeConfigKey>>>(
      spec.run({ args: { key: "services.web.type" }, flags: {} }),
    );
    expect(result).toMatchObject({ subcommand: "describe", key: "services.web.type", summary: "text" });
  },
);

test("global describe requires no global app service", async () => {
  expect(await Effect.runPromise(describeGlobalConfig({ key: "services" }))).toMatchObject({
    subcommand: "describe",
    key: "services",
    schema: { type: "object" },
  });
});

test("human descriptions render falsy defaults and aligned full child keys", () => {
  expect(
    renderConfigKeyDescription(
      {
        key: "feature",
        summary: "a mapping",
        description: "Feature settings.",
        default: false,
        keys: [{ key: "feature.enabled", summary: "`true` or `false`" }],
        schema: {},
      },
      "config.yml",
    ),
  ).toBe(
    "`feature` takes a mapping.\nFeature settings.\nDefault: false\nKEY              TAKES\nfeature.enabled  `true` or `false`",
  );
  expect(renderConfigKeyDescription({ key: "", summary: "a mapping", schema: {} }, "Landofile")).toBe(
    "Landofile takes a mapping.",
  );
});

test.each(["text", "json"] as const)(
  "unknown config keys render discovery hints in %s and exit with failure",
  async (resultFormat) => {
    const io = createBufferedRendererIO();
    const exitCodes: number[] = [];

    await runWithRendererHandling(describeConfigKey("installation", "router.httpPor"), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat,
      command: "meta:config",
      io,
      setExitCode: (code) => exitCodes.push(code),
      formatError: (failure) =>
        formatBugReport({
          ...failure,
          context: { commandId: "meta:config", cacheRoot: "/cache" },
          rendererMode: "plain",
        }),
    });

    expect(exitCodes).toEqual([1]);
    if (resultFormat === "json") {
      expect(io.stderr()).toBe("");
      expect(JSON.parse(io.stdout())).toMatchObject({
        ok: false,
        error: {
          _tag: "ConfigKeyNotFoundError",
          key: "router.httpPor",
          document: "config.yml",
          validKeys: expect.arrayContaining(["httpPort", "httpsPort"]),
          suggestion: 'Did you mean "httpPort"?',
          remediation: "Run `lando config describe router` to list the valid keys under router.",
        },
      });
    } else {
      expect(io.stdout()).toBe("");
      const diagnostic = io.stderr();
      expect(diagnostic).toContain("ConfigKeyNotFoundError");
      expect(diagnostic).toContain("key: router.httpPor");
      expect(diagnostic).toContain("document: config.yml");
      expect(diagnostic).toMatch(/validKeys: [^\n]*httpPort/);
      expect(diagnostic).toMatch(/validKeys: [^\n]*httpsPort/);
      expect(diagnostic).toContain('Did you mean "httpPort"?');
      expect(diagnostic).toContain("Run `lando config describe router` to list the valid keys under router.");
    }
  },
);
