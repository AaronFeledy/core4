import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppPlanner,
  ConfigService,
  LandofileService,
  RuntimeProviderRegistry,
  ToolingEngine,
} from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Layer } from "effect";
import { StreamFrameSink, type StreamFrameSinkFrame } from "../../src/operations/stream-frame-sink.ts";
import { runBunShellTooling } from "../../src/operations/tooling-bun-script.ts";
import { runTooling } from "../../src/operations/tooling.ts";

const frameText = (frame: StreamFrameSinkFrame) =>
  typeof frame.chunk === "string" ? frame.chunk : new TextDecoder().decode(frame.chunk);

test("emits both output streams before the script can finish", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-live-"));
  const gate = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async () => {
      await gate.promise;
      return new Response("released");
    },
  });
  const frames: StreamFrameSinkFrame[] = [];
  const sink = StreamFrameSink.of({
    emit: (frame) =>
      Effect.sync(() => {
        frames.push(frame);
        const stdout = frames
          .filter((entry) => entry._tag === "stdout")
          .map(frameText)
          .join("");
        const stderr = frames
          .filter((entry) => entry._tag === "stderr")
          .map(frameText)
          .join("");
        if (stdout.includes("first\n") && stderr.includes("diagnostic\n")) gate.resolve();
      }),
  });
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/probe.bun.sh"),
      [
        "# ---",
        "# desc: Live probe",
        "# ---",
        'echo "<$1>"',
        "echo first",
        "echo diagnostic 1>&2",
        `bun -e 'await fetch("http://127.0.0.1:${server.port}");'`,
        "echo second",
        "echo -n tail",
        "exit 3",
        "",
      ].join("\n"),
    );
    // When: the child cannot exit until its first stdout/stderr lines release the server.
    const result = await Effect.runPromise(
      runBunShellTooling({ name: "probe", input: { _tag: "RawArgv", argv: ["b c"] } }, root).pipe(
        Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer)),
        Effect.provideService(StreamFrameSink, sink),
        Effect.timeout("5 seconds"),
      ),
    );
    // Then
    expect(result).toMatchObject({
      exitCode: 3,
    });
    expect(result).not.toHaveProperty("stdout");
    expect(result).not.toHaveProperty("stderr");
    expect(
      frames
        .filter((frame) => frame._tag === "stdout")
        .map(frameText)
        .join(""),
    ).toBe("<b c>\nfirst\nsecond\ntail");
    expect(
      frames
        .filter((frame) => frame._tag === "stderr")
        .map(frameText)
        .join(""),
    ).toBe("diagnostic\n");
  } finally {
    gate.resolve();
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("returns nonzero script exits with both output streams intact", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-exit-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/probe.bun.sh"),
      "# ---\n# desc: Exit probe\n# ---\necho first; echo second; echo diagnostic 1>&2; exit 3\n",
    );
    // When
    const result = await Effect.runPromise(
      runBunShellTooling({ name: "probe" }, root).pipe(
        Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer)),
      ),
    );
    // Then
    expect(result).toEqual({
      tool: "app:probe",
      service: ":host",
      exitCode: 3,
      stdout: "first\nsecond\n",
      stderr: "diagnostic\n",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["direct", "fallback"] as const)(
  "forwards positional args through the %s script path",
  async (path) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-script-args-"));
    try {
      await mkdir(join(root, ".lando/scripts"), { recursive: true });
      await writeFile(join(root, ".lando.yml"), "name: script-args\n");
      await writeFile(
        join(root, ".lando/scripts/probe.bun.sh"),
        '# ---\n# desc: Args probe\n# ---\necho "<$1>"; echo "<$2>"; echo "<$3>"; echo "<$4>"\n',
      );
      const options = {
        name: "probe",
        input: { _tag: "RawArgv" as const, argv: ["a", "b c", "$(echo injected)", "*.ts"] },
        cwd: root,
      };
      const fallbackLayer = Layer.mergeAll(
        testEnvironmentResolverLayer,
        PrivateFileAccessService.layer,
        Layer.succeed(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed(literalTestLandofile({ name: "script-args" })) }),
        ),
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.die("script must skip planning") })),
        Layer.succeed(
          ConfigService,
          ConfigService.of({ load: Effect.die("unused"), get: () => Effect.die("unused") }),
        ),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
            appliedPlansFor: () => Effect.succeed([]),
            resolveAppliedPlan: () => Effect.succeed(undefined),
            resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
            list: Effect.die("unused"),
            capabilities: Effect.die("unused"),
            select: () => Effect.die("unused"),
          }),
        ),
        Layer.succeed(ToolingEngine, ToolingEngine.of({ id: "unused", run: () => Effect.die("unused") })),
      );
      // When
      const result = await Effect.runPromise(
        path === "direct"
          ? runBunShellTooling(options, root).pipe(
              Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer)),
            )
          : runTooling(options).pipe(Effect.provide(fallbackLayer)),
      );
      // Then
      expect(result).toMatchObject({ exitCode: 0, stdout: "<a>\n<b c>\n<$(echo injected)>\n<*.ts>\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("reports an interrupted script as exit 130 instead of a tooling failure", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "lando-script-interrupt-"));
  const controller = new AbortController();
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(
      join(root, ".lando/scripts/slow.bun.sh"),
      ["# ---", "# desc: Sleep until interrupted", "# ---", "sleep 30", ""].join("\n"),
    );
    setTimeout(() => controller.abort(), 200);
    // When
    const result = await Effect.runPromise(
      runBunShellTooling({ name: "slow", signal: controller.signal }, root).pipe(
        Effect.provide(Layer.merge(PrivateFileAccessService.layer, testEnvironmentResolverLayer)),
        Effect.timeout("5 seconds"),
      ),
    );
    // Then
    expect(result).toMatchObject({ tool: "app:slow", exitCode: 130 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
import { literalTestLandofile } from "../compiled-landofile.ts";
import { testEnvironmentResolverLayer } from "../environment-values.ts";
