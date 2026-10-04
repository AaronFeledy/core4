import { describe, expect, test } from "bun:test";
import { Effect, Result } from "effect";

import { loadTopLevelEnvFiles } from "../../src/planner/env-files.ts";

describe("env file validation issues", () => {
  test("keeps the parse diagnostic instead of a bare line label", async () => {
    const fileSystem = {
      readText: () => Effect.succeed("NOT VALID\n"),
    } as never;
    const result = await Effect.runPromise(
      Effect.result(
        loadTopLevelEnvFiles({
          appRoot: "/app",
          envFiles: [".env"],
          fileSystem,
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (!Result.isFailure(result)) return;
    const issue = result.failure.issues[0];
    expect(issue?.path).toEqual(["env_file", 0]);
    expect(issue?.message).toContain("Expected KEY=VALUE.");
    expect(issue?.message.startsWith("line ")).toBe(false);
  });
});
