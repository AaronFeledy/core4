import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadLandofileFile } from "../src/service.ts";

test.each(["service", "sources", "generates", "checksum", "timestamp"])(
  "names the deferred %s invocation scope at load",
  async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "lando-deferred-scopes-"));
    try {
      const file = join(root, ".lando.yml");
      await Bun.write(file, `name: scopes\ntooling:\n  inspect:\n    cmd: echo {{ ${scope}.value }}\n`);
      const result = await Effect.runPromise(Effect.result(loadLandofileFile(file)));
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "NotImplementedError",
          message: expect.stringContaining(`scope ${scope}`),
          remediation: expect.stringContaining("tooling.inspect.cmd"),
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
