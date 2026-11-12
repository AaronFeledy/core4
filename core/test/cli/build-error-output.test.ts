import { expect, test } from "bun:test";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { BuildPhaseFailedError, BuildStepFailedError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type BuildStep, ProviderId, ServiceName } from "@lando/sdk/schema";
import { DateTime, Effect, Layer } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { formatCommandError } from "../../src/cli/spec/command-spec.ts";

test.each(["text", "json"] as const)("surfaces the failing build step in %s output", async (format) => {
  // Given
  const io = createBufferedRendererIO();
  const providerId = ProviderId.make("lando");
  const app = AppId.make("build-output");
  const service = ServiceName.make("web");
  const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "test", runtime: 4 as const };
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
      sourceEnv: {},
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
    formatError: (failure) =>
      formatCommandError({ ...failure, commandId: "app:start", rendererMode: "plain" }),
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

test.each(["text", "json"] as const)(
  "renders a phase failure with messages, transcript paths, and output tails in %s output",
  async (format) => {
    // Given
    const io = createBufferedRendererIO();
    const app = AppId.make("build-phase-output");
    const service = ServiceName.make("web");
    const transcriptPath = AbsolutePath.make("/tmp/builds/build-phase-output/app/web/build.log");
    const step: BuildStep = {
      id: "web:app:install",
      service,
      phase: "app",
      kind: "execStream",
      command: ["install"],
      dependsOn: [],
      buildKey: "install-key",
    };
    const stepFailure = new BuildStepFailedError({
      step,
      exitCode: 1,
      transcriptPath,
      message: "Build step web:app:install for service web exited with code 1.",
      outputTail: "first line\nsecond line",
      remediation: `Inspect the build transcript at ${transcriptPath}, fix step web:app:install, and rebuild.`,
    });
    const error = new BuildPhaseFailedError({
      app: { kind: "user", id: app, root: AbsolutePath.make("/tmp/build-phase-output") },
      phase: "app",
      message: "App build failed: 1 of 1 build steps failed.",
      failures: [stepFailure],
      remediation: "Fix the reported app-phase build step failures and rebuild.",
    });

    // When
    await runWithRendererHandling(Effect.fail(error), {
      runtime: Layer.empty,
      rendererMode: "plain",
      io,
      command: "app:start",
      ...(format === "json" ? { resultFormat: "json" as const } : {}),
      formatError: (failure) =>
        formatCommandError({ ...failure, commandId: "app:start", rendererMode: "plain" }),
      setExitCode: () => undefined,
    });

    // Then
    const output = format === "json" ? io.stdout() : io.stderr();
    expect(output).toContain("App build failed: 1 of 1 build steps failed.");
    expect(output).toContain("Build step web:app:install for service web exited with code 1.");
    expect(output).toContain("first line");
    expect(output).toContain("second line");
    expect(output).toContain(transcriptPath);
    expect(output).not.toContain("An internal Lando error occurred.");
  },
);
