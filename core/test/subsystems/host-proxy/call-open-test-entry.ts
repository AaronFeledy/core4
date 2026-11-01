import { mock } from "bun:test";
import { appendFile } from "node:fs/promises";
import { installEngineComposition } from "@lando/engine/composition";
import type { LandoRuntimeOptions } from "@lando/engine/runtime/runtime-options";
import { EventService, ProcessRunner } from "@lando/sdk/services";
import { Effect, Layer, Stream } from "effect";
import { makeLandoRuntime } from "../../../src/runtime/layer";

const original = makeLandoRuntime;
const record = (value: unknown) =>
  appendFile(process.env.LANDO_TEST_OPEN_LOG ?? "", `${JSON.stringify(value)}\n`);
mock.module("../../../src/runtime/layer", () => ({
  makeLandoRuntime: (options: LandoRuntimeOptions & { readonly bootstrap: "plugins" }) => {
    if (process.argv.includes("__internal:host-proxy-worker")) throw new TypeError("Worker built a runtime");
    const base = original(options);
    const runner = Layer.succeed(
      ProcessRunner,
      ProcessRunner.of({
        run: (input) =>
          Effect.promise(() => record({ pid: process.pid, opener: input })).pipe(
            Effect.andThen(
              input.args?.includes("https://example.com/wait")
                ? Effect.sync(() => process.stderr.write("opener-ready\n")).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
            Effect.as({ exitCode: 0, stdout: "", stderr: "" }),
          ),
        stream: () => Stream.die("unused"),
        streamWithExit: () => Stream.die("unused"),
      }),
    );
    const events = Layer.effect(
      EventService,
      Effect.gen(function* () {
        const actual = yield* EventService;
        return EventService.of({
          ...actual,
          publish: (event) =>
            actual
              .publish(event)
              .pipe(
                Effect.andThen(
                  event._tag === "pre-host-proxy-call" || event._tag === "post-host-proxy-call"
                    ? Effect.promise(() => record({ pid: process.pid, event }))
                    : Effect.void,
                ),
              ),
        });
      }),
    ).pipe(Layer.provide(base));
    return Layer.mergeAll(base, runner, events);
  },
}));
const { runCli } = await import("../../../src/cli/run");
const composition = globalThis.__landoEngineCompositionInputs;
if (composition === undefined) throw new TypeError("Missing composition");
installEngineComposition({
  ...composition,
  hostProxyWorkerEntry: () => ({
    execPath: process.execPath,
    entryPath: undefined,
    bunSourceEntryPath: import.meta.path,
  }),
});
await runCli({ argv: process.argv.slice(2), rootUrl: import.meta.url });
