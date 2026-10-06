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
        if (
          frames.some((entry) => entry._tag === "stdout" && entry.chunk === "first\n") &&
          frames.some((entry) => entry._tag === "stderr" && entry.chunk === "diagnostic\n")
        )
          gate.resolve();
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
      runBunShellTooling({ name: "probe", args: ["b c"] }, root).pipe(
        Effect.provide(PrivateFileAccessService.layer),
        Effect.provideService(StreamFrameSink, sink),
        Effect.timeout("5 seconds"),
      ),
    );
    // Then
    expect(result).toMatchObject({
      exitCode: 3,
      stdout: "<b c>\nfirst\nsecond\ntail",
      stderr: "diagnostic\n",
      rendered: true,
    });
    expect(frames.filter((frame) => frame._tag === "stdout").map((frame) => frame.chunk)).toEqual([
      "<b c>\n",
      "first\n",
      "second\n",
      "tail",
    ]);
    expect(frames.filter((frame) => frame._tag === "stderr").map((frame) => frame.chunk)).toEqual([
      "diagnostic\n",
    ]);
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
      runBunShellTooling({ name: "probe" }, root).pipe(Effect.provide(PrivateFileAccessService.layer)),
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
      const options = { name: "probe", args: ["a", "b c", "$(echo injected)", "*.ts"], cwd: root };
      const fallbackLayer = Layer.mergeAll(
        PrivateFileAccessService.layer,
        Layer.succeed(
          LandofileService,
          LandofileService.of({ discover: Effect.succeed({ name: "script-args" }) }),
        ),
        Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.die("script must skip planning") })),
        Layer.succeed(
          ConfigService,
          ConfigService.of({ load: Effect.die("unused"), get: () => Effect.die("unused") }),
        ),
        Layer.succeed(
          RuntimeProviderRegistry,
          RuntimeProviderRegistry.of({
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
          ? runBunShellTooling(options, root).pipe(Effect.provide(PrivateFileAccessService.layer))
          : runTooling(options).pipe(Effect.provide(fallbackLayer)),
      );
      // Then
      expect(result).toMatchObject({ exitCode: 0, stdout: "<a>\n<b c>\n<$(echo injected)>\n<*.ts>\n" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
