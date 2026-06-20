import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { openJsonBucket } from "../../src/state-store/json-bucket.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("JSON state bucket", () => {
  test("advisory lock acquisition removes a fresh lock held by a dead pid", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-json-bucket-")));
    try {
      const bucket = await run(
        openJsonBucket({
          dir,
          key: "state.json",
          version: 1,
          schema: Schema.Array(Schema.String),
          lock: "advisory",
          default: [],
        }),
      );
      await mkdir(dir, { recursive: true });
      await writeFile(
        `${bucket.path}.lock`,
        JSON.stringify({ pid: 99_999_999, token: "dead", createdAt: Date.now() }),
      );

      const next = await run(bucket.update((current) => [...(current ?? []), "ok"]));

      expect(next).toEqual(["ok"]);
      expect(await readFile(bucket.path, "utf8")).toContain("ok");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
