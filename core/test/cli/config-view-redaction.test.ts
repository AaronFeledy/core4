import { expect, test } from "bun:test";
import { config } from "@lando/engine/operations/config";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { GlobalConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { metaConfigSpec } from "../../src/cli/command-specs/meta/config.ts";
import { renderConfigResult } from "../../src/cli/commands/config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const secret = "canary-config-opaque-value-626";
const loaded = Schema.decodeUnknownSync(GlobalConfig)({
  appEnv: { API_TOKEN: secret, TEAM: "platform" },
  appLabels: { owner: "platform", API_KEY: secret },
  network: { proxy: { https: "http://user:proxy-pass-626@proxy.invalid:3128" } },
});
const runtime = Layer.succeed(ConfigService, {
  load: Effect.succeed({ ...loaded, setup: { completed: true } }),
  get: (key) => Effect.succeed(loaded[key]),
});

for (const rendererMode of ["lando", "plain", "verbose", "json"] as const) {
  for (const format of ["table", "yaml", "json"] as const) {
    for (const key of [
      undefined,
      "appEnv",
      "appEnv.API_TOKEN",
      "appLabels.API_KEY",
      "network.proxy.https",
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
        expect(output).not.toContain("proxy-pass-626");
        expect(output).not.toContain("completed");
        if (format === "json" && key !== undefined) {
          expect(JSON.parse(output).result.key).toBe(key);
          expect(JSON.parse(output).result.config.appEnv.TEAM).toBe("platform");
        }
      });
    }
  }
}
