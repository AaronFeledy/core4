import { expect, test } from "bun:test";
import { makeLandoRuntime } from "@lando/core";
import { ProcessRunner, ShellRunner } from "@lando/sdk/services";
import { Effect } from "effect";

test.each(["provider", "app"] as const)(
  "%s bootstrap supplies captured host execution without provider setup",
  async (bootstrap) => {
    // Given
    const runtime =
      bootstrap === "provider"
        ? makeLandoRuntime({ bootstrap: "provider", plugins: { policy: "bundled-only" } })
        : makeLandoRuntime({ bootstrap: "app", plugins: { policy: "bundled-only" } });
    // When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const shell = yield* ShellRunner;
        const processRunner = yield* ProcessRunner;
        const argv = yield* processRunner.run({
          cmd: process.execPath,
          args: ["-e", "process.exit(0)"],
          capture: true,
        });
        const command = yield* shell.run("true", { capture: true });
        return [argv.exitCode, command.exitCode];
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    );
    // Then
    expect(result).toEqual([0, 0]);
  },
);
