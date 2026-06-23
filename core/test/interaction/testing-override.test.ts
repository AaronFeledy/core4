import { describe, expect, test } from "bun:test";

import { Context, Effect, Layer } from "effect";

import { InteractionService } from "@lando/sdk/services";

import { InteractionServiceLive } from "../../src/interaction/service.ts";
import {
  getInteractionServiceOverride,
  withInteractionServiceOverride,
} from "../../src/interaction/testing-override.ts";
import { makeTestInteractionService } from "../../src/testing/interaction.ts";

const buildLiveId = (): Promise<string> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(InteractionServiceLive);
        return Context.get(context, InteractionService).id;
      }),
    ),
  );

describe("interaction testing override", () => {
  test("no override is active by default", () => {
    expect(getInteractionServiceOverride()).toBeUndefined();
  });

  test("InteractionServiceLive resolves the default stdio service with no override", async () => {
    await expect(buildLiveId()).resolves.toBe("stdio");
  });

  test("InteractionServiceLive consults the active override inside the scope", async () => {
    const test = makeTestInteractionService({ answers: { app: "x" } });
    const id = await withInteractionServiceOverride(test.service, () => buildLiveId());
    expect(id).toBe("test-stdio");
  });

  test("the override is cleared outside the scope", async () => {
    const test = makeTestInteractionService({ answers: { app: "x" } });
    await withInteractionServiceOverride(test.service, () => Promise.resolve());
    await expect(buildLiveId()).resolves.toBe("stdio");
  });

  test("the override is observable inside an async dispatch thunk (scenario seam)", async () => {
    const test = makeTestInteractionService({ answers: { name: "scenario-app" } });
    const seen = await withInteractionServiceOverride(test.service, async () => {
      await Promise.resolve();
      return getInteractionServiceOverride()?.id;
    });
    expect(seen).toBe("test-stdio");
  });
});
