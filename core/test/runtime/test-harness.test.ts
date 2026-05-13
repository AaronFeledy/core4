import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { ConfigService, FileSystem, Logger, ProcessRunner } from "@lando/core/services";
import { makeTestRuntime } from "@lando/core/testing";

describe("makeTestRuntime", () => {
  test("provides in-memory service doubles that record calls", async () => {
    const runtime = makeTestRuntime({ files: { "/tmp/source": "contents" } });

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* (yield* Logger).debug("checking runtime");
        yield* (yield* FileSystem).readFile("/tmp/source");
        yield* (yield* ProcessRunner).run({ cmd: "true", args: [] });
        yield* (yield* ConfigService).load;
      }).pipe(Effect.provide(runtime.layer)),
    );

    expect(runtime.calls.logger).toEqual([{ level: "debug", message: "checking runtime" }]);
    expect(runtime.calls.fileSystem).toEqual([{ operation: "readFile", path: "/tmp/source" }]);
    expect(runtime.calls.processRunner).toEqual([{ cmd: "true", args: [] }]);
    expect(runtime.calls.config).toEqual(["load"]);
  });
});
