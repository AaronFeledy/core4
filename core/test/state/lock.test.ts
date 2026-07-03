import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";

import { withAdvisoryLock } from "../../src/state/lock.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("advisory state lock", () => {
  test("acquisition takes over a fresh lock held by a dead pid", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      await writeFile(
        `${file}.lock`,
        JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }),
      );

      const result = await run(
        withAdvisoryLock(
          file,
          "test",
          Effect.promise(async () => {
            await writeFile(file, JSON.stringify(["ok"]));
            return "ran";
          }),
        ),
      );

      expect(result).toBe("ran");
      expect(await readFile(file, "utf8")).toContain("ok");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
