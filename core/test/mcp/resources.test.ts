import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeLayerFactory } from "@lando/engine/runtime/runtime-layer-factory";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { PrivilegeService, RuntimeProvider, RuntimeProviderRegistry } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Context, Effect, Fiber, Layer, Schema } from "effect";
import { serviceLayer } from "../../src/mcp-command-executor";
import { resources } from "../../src/mcp-resources";
import { makeLandoRuntime } from "../../src/runtime/layer";

type Client = Effect.Success<ReturnType<typeof startStdioClient>>;
const secret = "mcp-resource-config-planted-secret";

const withResourceSession = async <A, E>(
  run: (client: Client) => Effect.Effect<A, E>,
  withApp = true,
): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-resources-"));
  let mutations = 0;
  const rejectMutation = () =>
    Effect.sync(() => {
      mutations++;
    }).pipe(Effect.andThen(Effect.die(new Error("A resource attempted to mutate the host or provider."))));
  const provider = RuntimeProvider.of({
    ...TestRuntimeProvider,
    apply: rejectMutation,
    start: rejectMutation,
    stop: rejectMutation,
    restart: rejectMutation,
    destroy: rejectMutation,
    setup: rejectMutation,
  });
  if (withApp)
    await Bun.write(
      join(root, ".lando.yml"),
      `name: resource-app\nruntime: 4\nprovider: ${provider.id}\nservices:\n  web:\n    image: node:lts\n    primary: true\n    home: false\n    environment:\n      API_TOKEN: ${secret}\n`,
    );
  try {
    const runtimeLayer = makeLandoRuntime({
      bootstrap: "app",
      cwd: root,
      logger: "silent",
      telemetry: false,
      config: {
        userConfRoot: AbsolutePath.make(join(root, "config")),
        userDataRoot: AbsolutePath.make(join(root, "data")),
        userCacheRoot: AbsolutePath.make(join(root, "cache")),
        defaultProviderId: ProviderId.make(provider.id),
      },
      plugins: {
        policy: "bundled-only",
        layers: [
          Layer.succeed(RuntimeProvider, provider),
          Layer.succeed(
            RuntimeProviderRegistry,
            RuntimeProviderRegistry.of({
              list: Effect.succeed([ProviderId.make(provider.id)]),
              capabilities: Effect.succeed(provider.capabilities),
              select: () => Effect.succeed(provider),
            }),
          ),
          Layer.succeed(PrivilegeService, PrivilegeService.of({ elevate: rejectMutation })),
        ],
      },
    });
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Layer.build(runtimeLayer);
          const retained = Context.add(
            runtime,
            RuntimeLayerFactory,
            RuntimeLayerFactory.of({ make: () => Layer.succeedContext(runtime) }),
          );
          const config = McpRuntimeConfig.of({
            commandEntries: [],
            defaultAllowlist: [],
            resources,
            runtimeLayer: Layer.succeedContext(retained),
          });
          const host = serviceLayer.pipe(
            Layer.provide(Layer.succeedContext(retained)),
            Layer.provide(Layer.succeed(McpRuntimeConfig, config)),
          );
          const service = yield* McpService.pipe(Effect.provide(host));
          const client = yield* startStdioClient(service.serve({ transport: "stdio", cwd: root }));
          const result = yield* run(client);
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return result;
        }),
      ),
    );
    expect(mutations).toBe(0);
    return observed;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("lists core-owned resources with their registered schemas and JSON MIME types", async () => {
  const response = await withResourceSession((client) => client.request("resources/list"));
  expect(response).toMatchObject({
    result: {
      resources: resources.map(({ uri, name, description }) => ({
        uri,
        name,
        description,
        mimeType: "application/json",
      })),
    },
  });
});

test.each(resources.map((entry) => [entry.uri, entry] as const))(
  "reads production resource %s through its real result schema",
  async (uri, entry) => {
    const response = await withResourceSession((client) => client.request("resources/read", { uri }));
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        contents: Schema.Array(
          Schema.Struct({
            uri: Schema.String,
            mimeType: Schema.Literal("application/json"),
            text: Schema.String,
          }),
        ),
      }),
    )(response.result);
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.uri).toBe(uri);
    const payload: unknown = JSON.parse(result.contents[0]?.text ?? "null");
    expect(Schema.is(Schema.toEncoded(entry.resultSchema))(payload)).toBe(true);
    if (uri === "lando://app/config") {
      expect(payload).toMatchObject({
        app: "resource-app",
        landofile: { services: { web: { environment: { API_TOKEN: "[redacted]" } } } },
      });
      expect(JSON.stringify(response)).not.toContain(secret);
    }
    if (uri === "lando://app/info") expect(payload).toMatchObject({ app: "resource-app" });
  },
);

test.each(["lando://app/config", "lando://app/info"])(
  "missing-app resource %s preserves the app-resolution error tag",
  async (uri) => {
    const response = await withResourceSession((client) => client.request("resources/read", { uri }), false);
    const error = Schema.decodeUnknownSync(
      Schema.Struct({
        code: Schema.Literal(-32603),
        message: Schema.String,
        data: Schema.Struct({
          _tag: Schema.Literal("AppResolveError"),
          message: Schema.String,
          remediation: Schema.String,
        }),
      }),
    )(response.error);
    expect(error.message).toBe("Failed to resolve app (LandofileNotFoundError).");
    expect(error.data).toEqual({
      _tag: "AppResolveError",
      message: error.message,
      remediation: "Check the resource and retry.",
    });
  },
);
