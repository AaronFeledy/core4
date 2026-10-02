import { expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { AbsolutePath, AppId, ProviderId, ServiceName } from "@lando/sdk/schema";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { formatCommandError } from "../../src/cli/spec/command-spec.ts";

test.each(["text", "json"] as const)("surfaces the failing build step in %s output", async (format) => {
  // Given
  const io = createBufferedRendererIO();
  const providerId = ProviderId.make("lando");
  const app = AppId.make("build-output");
  const service = ServiceName.make("web");
  const metadata = { resolvedAt: DateTime.unsafeMake(0), source: "test", runtime: 4 as const };
  const build = buildContainerArtifact(
    {
      app,
      service,
      buildKey: "build-output",
      plan: {
        id: app,
        name: "test",
        slug: "test",
        root: AbsolutePath.make("/tmp/build-output"),
        provider: providerId,
        metadata,
        extensions: {},
        routes: [],
        networks: [],
        stores: [],
        fileSync: [],
        services: {
          [service]: {
            name: service,
            type: "node",
            provider: providerId,
            primary: true,
            artifact: { kind: "ref", ref: "alpine:3.22" },
            environment: {},
            mounts: [],
            storage: [],
            endpoints: [],
            routes: [],
            dependsOn: [],
            hostAliases: [],
            metadata,
            extensions: {
              "@lando/core/service-features": {
                buildSteps: [{ id: "step", phase: "build", command: "mkdir -p /etc/lando" }],
              },
            },
          },
        },
      },
    },
    {
      providerId,
      api: {
        request: () =>
          Effect.succeed({
            status: 200,
            body: JSON.stringify({
              errorDetail: {
                message: 'building at STEP "RUN mkdir -p /etc/lando": password=hunter2 exit status 1',
              },
            }),
          }),
      },
    },
  );

  // When
  await runWithRendererHandling(build, {
    runtime: Layer.empty,
    rendererMode: "plain",
    io,
    command: "app:start",
    ...(format === "json" ? { resultFormat: "json" as const } : {}),
    formatError: (error) => formatCommandError({ error, commandId: "app:start", rendererMode: "plain" }),
    setExitCode: () => undefined,
  });

  // Then
  const output = format === "json" ? io.stdout() : io.stderr();
  expect(output).toContain("mkdir -p /etc/lando");
  expect(output).toContain("exit status 1");
  expect(output).toContain("ArtifactBuildError");
  expect(output).toContain("[redacted]");
  expect(output).not.toContain("hunter2");
});
