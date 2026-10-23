import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "@lando/engine/operations/config";
import { GlobalConfigSources } from "@lando/engine/services/config";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { GlobalConfig } from "@lando/sdk/schema";
import { Layer, Schema } from "effect";
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
const runtime = Layer.succeed(GlobalConfigSources, {
  env: {},
  host: { ...loaded, setup: { completed: true } },
  sources: { user: false, env: false },
});

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
          formatError: ({ error }) => String(error),
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

for (const headers of ["scalar", "map", "array"] as const) {
  for (const subcommand of ["view", "get"] as const) {
    test(`raw ${subcommand} redacts ${headers} headers and nested secret-key values`, async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-raw-redaction-"));
      const canary = "raw-header-secret-canary-134687";
      const secretKeyCanary = "raw-key-secret-canary-568972";
      const value =
        headers === "scalar"
          ? canary
          : headers === "map"
            ? `\n      x-team: ${canary}`
            : `\n      - ${canary}`;
      await writeFile(
        join(root, "config.yml"),
        `tracing:\n  otlp:\n    headers: ${value}\npluginConfig:\n  example:\n    API_TOKEN:\n      nested: ${secretKeyCanary}\n`,
      );
      const io = createBufferedRendererIO();
      try {
        await runWithRendererHandling(config({ subcommand, source: "raw", key: "tracing.otlp.headers" }), {
          runtime: Layer.succeed(GlobalConfigSources, {
            env: {},
            rootOverrides: { userConfRoot: root },
            sources: { user: true, env: false },
          }),
          rendererMode: "json",
          resultFormat: "json",
          resultSchema: metaConfigSpec.resultSchema,
          redactionTokens: configRedactionTokens,
          render: renderConfigResult,
          io,
          formatError: ({ error }) => String(error),
          setExitCode: (code) => expect(code).toBe(0),
        });
        expect(JSON.parse(io.stdout()).ok).toBe(true);
        expect(io.stdout()).toContain("[redacted]");
        expect(io.stdout()).not.toContain(canary);
        expect(io.stdout()).not.toContain(secretKeyCanary);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

test.each(["view", "validate"] as const)(
  "%s error envelope does not echo invalid secret values",
  async (subcommand) => {
    const root = await mkdtemp(join(tmpdir(), "lando-failure-redaction-"));
    const canary = "failure-header-secret-canary-943628";
    await writeFile(join(root, "config.yml"), `tracing:\n  otlp:\n    headers: ${canary}\n`);
    const io = createBufferedRendererIO();
    try {
      await runWithRendererHandling(config({ subcommand }), {
        runtime: Layer.succeed(GlobalConfigSources, {
          env: {},
          rootOverrides: { userConfRoot: root },
          sources: { user: true, env: false },
        }),
        rendererMode: "json",
        resultFormat: "json",
        resultSchema: metaConfigSpec.resultSchema,
        redactionTokens: configRedactionTokens,
        render: renderConfigResult,
        io,
        formatError: ({ error }) => String(error),
        setExitCode: (code) => expect(code).toBe(1),
      });
      expect(JSON.parse(io.stdout())).toMatchObject({
        ok: false,
        error: { _tag: "ConfigError", issues: [{ path: ["tracing", "otlp", "headers"] }] },
      });
      expect(io.stdout() + io.stderr()).not.toContain(canary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
