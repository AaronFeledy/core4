import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath } from "@lando/sdk/schema";
import { ProcessRunner, StateStore } from "@lando/sdk/services";
import { Effect, Layer, Schema, Stream } from "effect";
import * as privateAccess from "../../src/private-file-access.ts";
import { StateStoreLive } from "../../src/service.ts";

test("the default state layer uses its runner for Windows advisory-lock ACLs", async () => {
  // Given the Windows ACL implementation and a recording runner on any host
  const root = await mkdtemp(join(tmpdir(), "lando-state-windows-wiring-"));
  const commands: string[] = [];
  const makeAccess = privateAccess.makeOwnerOnlyFileAccess;
  const accessSpy = spyOn(privateAccess, "makeOwnerOnlyFileAccess").mockImplementation((options) =>
    makeAccess({ ...options, platform: "win32", env: { SystemRoot: "C:\\Windows" } }),
  );
  const runner = Layer.succeed(ProcessRunner, {
    run: (input) => {
      commands.push(Buffer.from(input.args.at(-1) ?? "", "base64").toString("utf16le"));
      return Effect.succeed({ exitCode: 0, stdout: "", stderr: "" });
    },
    stream: () => Stream.die("Unexpected stream"),
  });
  try {
    // When a provider-shaped advisory bucket persists a plan through the default layer
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* StateStore;
        const bucket = yield* store.open({
          root: { path: AbsolutePath.make(root) },
          key: "applied-plans.json",
          schema: Schema.Record({ key: Schema.String, value: Schema.String }),
          version: 1,
          mode: 0o600,
          lock: "advisory",
        });
        yield* bucket.modify(() => [undefined, { app: "plan" }]);
      }).pipe(Effect.provide(StateStoreLive.pipe(Layer.provide(runner)))),
    );
    // Then lock creation, private data publication, and lock release all run the ACL scripts
    expect(commands).toEqual([
      privateAccess.OWNER_ONLY_FILE_ACL_SCRIPT,
      privateAccess.OWNER_ONLY_FILE_ACL_SCRIPT,
      privateAccess.VERIFY_OWNER_ONLY_FILE_ACL_SCRIPT,
    ]);
  } finally {
    accessSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
