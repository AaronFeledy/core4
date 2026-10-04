import { expect, test } from "bun:test";
import { config } from "@lando/engine/operations/config";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { metaConfigSpec } from "../../src/cli/command-specs/meta/config.ts";
import { configRedactionTokens } from "../../src/cli/commands/config-redaction.ts";
import { renderConfigResult } from "../../src/cli/commands/config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const secret = "canary-config-opaque-value-626";
const dottedSecret = "canary-dotted-label-value-633";
const hyphenatedSecret = "canary-hyphenated-label-value-633";
const loaded = Schema.decodeUnknownSync(GlobalConfig)({
  appEnv: { API_TOKEN: secret, TEAM: "platform" },
  appLabels: {
    owner: "platform",
    API_KEY: secret,
    "com.example.password": dottedSecret,
    "dev.example.db-password": hyphenatedSecret,
    "com.example.team": "platform-team",
  },
  network: { proxy: { https: "http://user:proxy-pass-626@proxy.invalid:3128" } },
  tracing: {
    otlp: { headers: { "x-team": "opaque-otlp-header-669", authorization: "opaque-otlp-auth-669" } },
  },
});
const runtime = Layer.succeed(
  ConfigService,
  ConfigService.of({
    load: Effect.succeed({ ...loaded, setup: { completed: true } }),
    get: (key) => Effect.succeed(loaded[key]),
  }),
);

test("marks arbitrary OTLP header names as secrets in scalar set and map get shapes", () => {
  expect(
    configRedactionTokens({ key: "tracing.otlp.headers.x-team", value: "opaque-set-header-669" }),
  ).toContain("opaque-set-header-669");
  expect(
    configRedactionTokens({ key: "tracing.otlp.headers", value: { "x-team": "opaque-get-header-669" } }),
  ).toContain("opaque-get-header-669");
});

for (const rendererMode of ["lando", "plain", "verbose", "json"] as const) {
  for (const format of ["table", "yaml", "json"] as const) {
    for (const key of [
      undefined,
      "appEnv",
      "appEnv.API_TOKEN",
      "appLabels.API_KEY",
      "network.proxy.https",
      "tracing.otlp.headers",
      "tracing.otlp.headers.x-team",
    ] as const) {
      test(`${rendererMode}/${format} redacts config when selecting ${key ?? "view"}`, async () => {
        // Given
        const io = createBufferedRendererIO();
        const operation = config({ format, ...(key === undefined ? {} : { subcommand: "get", key }) });
        // When
        await runWithRendererHandling(operation, {
          runtime,
          rendererMode,
          resultFormat: format === "table" ? "text" : format,
          resultSchema: metaConfigSpec.resultSchema,
          redactionTokens: (result) => metaConfigSpec.redactionTokens?.(result) ?? [],
          render: renderConfigResult,
          io,
          formatError: String,
          setExitCode: (code) => expect(code).toBe(0),
        });
        // Then
        const output = io.stdout();
        expect(output).toContain("[redacted]");
        expect(output).not.toContain(secret);
        expect(output).not.toContain(dottedSecret);
        expect(output).not.toContain(hyphenatedSecret);
        expect(output).not.toContain("proxy-pass-626");
        expect(output).not.toContain("opaque-otlp-header-669");
        expect(output).not.toContain("opaque-otlp-auth-669");
        expect(output).not.toContain("completed");
        if (format === "json" && key !== undefined) {
          expect(JSON.parse(output).result.key).toBe(key);
          expect(JSON.parse(output).result.config.appEnv.TEAM).toBe("platform");
          expect(JSON.parse(output).result.config.appLabels["com.example.team"]).toBe("platform-team");
        }
      });
    }
  }
}
