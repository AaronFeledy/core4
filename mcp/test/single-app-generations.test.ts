import { expect, test } from "bun:test";
import { Context, Effect } from "effect";

import { withAppDiscovery } from "@lando/landofile/operation-discovery";

import { singleAppGenerations } from "../src/apps.ts";

test("single-app generations key each acquisition by its own directory and reuse it", async () => {
  // Given generations over one shared context
  const apps = singleAppGenerations(Context.empty());

  // When two directories are acquired, then the first again through a normalized spelling
  const [first, second, again] = await Effect.runPromise(
    withAppDiscovery(
      "/apps",
      Effect.scoped(
        Effect.all([apps.acquire("/apps/a"), apps.acquire("/apps/b"), apps.acquire("/apps/b/../a")]),
      ),
    ),
  );

  // Then each directory has its own generation, stable across acquisitions
  expect([first.key, second.key]).toEqual(["/apps/a", "/apps/b"]);
  expect(again).toBe(first);
});
