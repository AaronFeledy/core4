import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRuntimeConfig, McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { RedactionService } from "@lando/redaction/service";
import { AbsolutePath, CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Fiber, Layer, Schema } from "effect";
import { appConfigMcpSpecs } from "../../src/cli/command-specs/app/config/index.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";
import { serviceLayer } from "../../src/mcp-command-executor.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";

test("canonical MCP execution preserves and redacts broken-app aggregate diagnostics on both envelopes (#1646)", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mcp-load-failures-"));
  const secret = "mcp-load-private-token";
  try {
    await writeFile(
      join(root, ".lando.yml"),
      `name: mcp-broken\nincludes: [./${secret}.yml, ./other-missing.yml]\n`,
    );
    const realSpec = appConfigMcpSpecs.find(({ id }) => id === "app:config:get");
    if (realSpec === undefined) throw new Error("Missing app config MCP spec");
    const spec: LandoCommandSpec = realSpec;
    const runtimeLayer = makeLandoRuntime({
      bootstrap: "app",
      cwd: root,
      logger: "silent",
      telemetry: false,
      plugins: { policy: "bundled-only" },
      config: {
        userConfRoot: AbsolutePath.make(join(root, "conf")),
        userDataRoot: AbsolutePath.make(join(root, "data")),
        userCacheRoot: AbsolutePath.make(join(root, "cache")),
      },
    });
    const response = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const retained = yield* Layer.build(runtimeLayer);
          yield* RedactionService.use((redaction) => redaction.registerValues([secret])).pipe(
            Effect.provide(retained),
          );
          const host = serviceLayer.pipe(
            Layer.provide(Layer.succeedContext(retained)),
            Layer.provide(
              Layer.succeed(
                McpRuntimeConfig,
                McpRuntimeConfig.of({
                  commandEntries: [{ spec }],
                  defaultAllowlist: [spec.id],
                  runtimeLayer: Layer.succeedContext(retained),
                }),
              ),
            ),
          );
          const service = yield* McpService.pipe(Effect.provide(host));
          const client = yield* startStdioClient(service.serve({ transport: "stdio", cwd: root }));
          const result = yield* client.request("tools/call", {
            name: spec.id,
            arguments: { args: { key: "name" } },
          });
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return result;
        }),
      ),
    );
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        isError: Schema.Literal(true),
        structuredContent: CommandResultEnvelope,
        content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
      }),
    )(response.result);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: {
        _tag: "LandofileLoadError",
        message: "Landofile loading failed with 2 problems.",
        failures: [
          {
            _tag: "LandofileIncludeError",
            path: ["includes", 0],
            file: join(root, ".lando.yml"),
            layer: "canonical",
            source: "./[redacted].yml",
            message: expect.stringContaining("[redacted]"),
            remediation:
              "Check the includes: entry and retry after the referenced Landofile fragment is available.",
          },
          {
            _tag: "LandofileIncludeError",
            path: ["includes", 1],
            file: join(root, ".lando.yml"),
            layer: "canonical",
            source: "./other-missing.yml",
            remediation:
              "Check the includes: entry and retry after the referenced Landofile fragment is available.",
          },
        ],
      },
    });
    expect(JSON.parse(result.content[0]?.text ?? "null")).toEqual(result.structuredContent);
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(result.structuredContent.error?.remediation).toBe(
      "Fix each listed failure, then rerun the command.",
    );
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
