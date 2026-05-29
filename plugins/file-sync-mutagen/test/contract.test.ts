import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  type FileSyncContractMatrixCell,
  runFileSyncEngineContract,
  runFileSyncEngineContractMatrix,
} from "@lando/sdk/test";

import { ENGINE_ID, makeFakeMutagenClient, makeFileSyncEngine } from "../src/index.ts";

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

describe("@lando/file-sync-mutagen live contract matrix (gated: LANDO_TEST_FILE_SYNC_LIVE=1)", () => {
  test("satisfies runFileSyncEngineContractMatrix on all canonical platforms", async () => {
    if (process.env.LANDO_TEST_FILE_SYNC_LIVE !== "1") return;

    const currentPlatform: "darwin" | "linux" | "win32" | "wsl" =
      process.platform === "darwin"
        ? "darwin"
        : process.platform === "win32"
          ? "win32"
          : process.env.WSL_DISTRO_NAME !== undefined
            ? "wsl"
            : "linux";

    const cells: ReadonlyArray<FileSyncContractMatrixCell> = (
      ["darwin", "linux", "win32", "wsl"] as const
    ).map((platform) =>
      platform === currentPlatform
        ? {
            platform,
            supported: true,
            factory: () => Effect.succeed(makeFileSyncEngine({ client: makeFakeMutagenClient() })),
          }
        : {
            platform,
            supported: false,
            skipReason: `not the current runtime platform (running on ${currentPlatform})`,
          },
    );

    const exit = await Effect.runPromiseExit(
      runFileSyncEngineContractMatrix({ engineName: ENGINE_ID, cells }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Matrix contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
    const currentResult = exit.value.results.find((r) => r.platform === currentPlatform);
    expect(currentResult?.outcome).toBe("passed");
  });
});
