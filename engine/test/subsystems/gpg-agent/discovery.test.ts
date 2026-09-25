import { expect, test } from "bun:test";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect } from "effect";

test("prefers an explicit socket without invoking gpgconf", async () => {
  // Given
  const calls: string[] = [];
  const runner: Pick<ProcessRunner["Type"], "run"> = {
    run: ({ args }) => {
      calls.push(...args);
      return Effect.succeed({ exitCode: 0, stdout: "/other", stderr: "" });
    },
  };
  const { discoverHostGpgAgent } = await import("../../../src/subsystems/gpg-agent/discovery.ts");
  // When
  const result = await Effect.runPromise(
    discoverHostGpgAgent({ runner, explicitSocket: "/explicit", exists: async () => true }),
  );
  // Then
  expect(result).toEqual({ _tag: "unix", path: "/explicit", source: "explicit" });
  expect(calls).toEqual([]);
});

test("reports gpg-missing when gpgconf is unavailable", async () => {
  // Given
  const runner: Pick<ProcessRunner["Type"], "run"> = {
    run: () => Effect.succeed({ exitCode: 127, stdout: "", stderr: "" }),
  };
  const { discoverHostGpgAgent } = await import("../../../src/subsystems/gpg-agent/discovery.ts");
  // When
  const result = await Effect.runPromise(
    Effect.either(discoverHostGpgAgent({ runner, exists: async () => false })),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "GpgAgentUnavailableError", reason: "gpg-missing" },
  });
});

test("launches once then fails socket-missing when the socket remains absent", async () => {
  // Given
  const calls: ReadonlyArray<string>[] = [];
  const runner: Pick<ProcessRunner["Type"], "run"> = {
    run: ({ args }) => {
      calls.push(args);
      return Effect.succeed({ exitCode: 0, stdout: "/extra\n", stderr: "" });
    },
  };
  const { discoverHostGpgAgent } = await import("../../../src/subsystems/gpg-agent/discovery.ts");
  // When
  const result = await Effect.runPromise(
    Effect.either(discoverHostGpgAgent({ runner, exists: async () => false })),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "socket-missing" } });
  expect(calls).toEqual([
    ["--list-dirs", "agent-extra-socket"],
    ["--launch", "gpg-agent"],
  ]);
});
