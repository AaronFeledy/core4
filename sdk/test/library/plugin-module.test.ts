import { describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  type ExecutableCommandInput,
  type ExecutableCommandRenderContext,
  type ExecutableCommandSpec,
  type LandoPluginModule,
  definePlugin,
} from "@lando/sdk/plugins";
import { PluginManifest, ProviderId } from "@lando/sdk/schema";
import { CertificateAuthority } from "@lando/sdk/services";

type Extends<A, B> = [A] extends [B] ? true : false;
type ExpectTrue<T extends true> = T;
type ExpectFalse<T extends false> = T;

const manifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/test-plugin-module",
  version: "0.0.0",
  api: 4,
  requires: { "@lando/core": "^4.0.0" },
  contributes: { providers: ["manifest-provider"] },
  entry: "./src/index.ts",
});

describe("definePlugin", () => {
  test("returns the same descriptor when given a minimal plugin module", () => {
    // Given
    const descriptor: LandoPluginModule = { name: manifest.name, manifest };

    // When
    const defined = definePlugin(descriptor);

    // Then
    expect(defined).toBe(descriptor);
  });

  test("keeps manifest provider declarations inspectable beside runtime provider keys", () => {
    // Given
    const descriptor = definePlugin({
      name: manifest.name,
      manifest,
      runtimeProviders: new Map(),
    });

    // When
    const manifestProviderIds = (descriptor.manifest.contributes?.providers ?? []).map((entry) =>
      typeof entry === "string" ? entry : entry.id,
    );
    const runtimeProviderIds = [...(descriptor.runtimeProviders?.keys() ?? [])];
    const missingProviderIds = manifestProviderIds.filter(
      (id) => !runtimeProviderIds.includes(Schema.decodeSync(ProviderId)(id)),
    );

    // Then
    expect(missingProviderIds).toEqual(["manifest-provider"]);
  });

  test("keeps typed certificate authority layers keyed by manifest id", () => {
    const caManifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/test-ca-module",
      version: "1.0.0",
      api: 4,
      contributes: {
        certificateAuthorities: [{ id: "test-ca", module: "./src/ca.ts" }],
      },
    });
    const caLayer = Layer.succeed(CertificateAuthority, {
      id: "test-ca",
      setup: () => Effect.void,
      issueCert: () => Effect.die("not exercised"),
    });

    const descriptor = definePlugin({
      name: caManifest.name,
      manifest: caManifest,
      certificateAuthorities: new Map([["test-ca", caLayer]]),
    });

    expect(descriptor.certificateAuthorities?.get("test-ca")).toBe(caLayer);
  });
});

describe("ExecutableCommandSpec contract", () => {
  test("accepts a plugin cspace topic namespace and Effect-only render hook", async () => {
    // Given — type-level: cspace topic assignable; render is Effect(context) only
    type PluginDbSpec = {
      readonly id: "db:import";
      readonly summary: "Import a database dump.";
      readonly namespace: "db";
      readonly bootstrap: "app";
      readonly run: (input: ExecutableCommandInput) => Effect.Effect<string, never, never>;
      readonly resultSchema: typeof Schema.String;
      readonly render: (context: ExecutableCommandRenderContext<string>) => Effect.Effect<void, never, never>;
    };
    type _cspaceOk = ExpectTrue<Extends<PluginDbSpec, ExecutableCommandSpec<string, never, never>>>;
    type _renderOk = ExpectTrue<
      Extends<
        NonNullable<ExecutableCommandSpec<string, never, never>["render"]>,
        (context: ExecutableCommandRenderContext<string>) => Effect.Effect<void, never, never>
      >
    >;
    // Legacy string render is NOT part of the SDK contract
    type LegacyStringRender = (result: string, input?: unknown, ctx?: unknown) => string | undefined;
    type _noStringRender = ExpectFalse<
      Extends<LegacyStringRender, NonNullable<ExecutableCommandSpec<string>["render"]>>
    >;

    let captured: ExecutableCommandRenderContext<string> | undefined;
    const spec: ExecutableCommandSpec<string, never, never> = {
      id: "db:import",
      summary: "Import a database dump.",
      namespace: "db",
      bootstrap: "app",
      resultSchema: Schema.String,
      run: () => Effect.succeed("ok"),
      render: (context) =>
        Effect.sync(() => {
          captured = context;
        }),
    };

    // When
    await Effect.runPromise(
      spec.render?.({
        input: { argv: [], parsedArgv: [], flags: {}, args: {} },
        result: "ok",
        stdout: "out\n",
        stderr: "err\n",
        exitCode: 0,
      }) ?? Effect.void,
    );

    // Then
    expect(spec.namespace).toBe("db");
    expect(captured).toEqual({
      input: { argv: [], parsedArgv: [], flags: {}, args: {} },
      result: "ok",
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 0,
    });
  });
});
