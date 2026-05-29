import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runFileSyncEngineContract } from "@lando/sdk/test";

import { makeFakeMutagenClient, makeFileSyncEngine } from "../src/index.ts";

describe("@lando/file-sync-mutagen contract", () => {
  test("satisfies runFileSyncEngineContract against the fake client", async () => {
    const engine = makeFileSyncEngine({ client: makeFakeMutagenClient() });
    const exit = await Effect.runPromiseExit(runFileSyncEngineContract(engine));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });
});
