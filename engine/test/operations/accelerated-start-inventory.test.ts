import { expect, test } from "bun:test";
import { FileIoError } from "@lando/sdk/errors";
import { FileSystem } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import { acceleratedStartInventory } from "../../src/operations/accelerated-start-inventory.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

test.each(["ENOTDIR", "EIO", "EPERM"])(
  "journal inventory handles directory error %s without hiding unrelated failures",
  async (code) => {
    // Given a namespace lookup that fails at the filesystem boundary.
    const store = makeTestStateStore();
    const failure = new FileIoError({
      message: "Directory lookup failed",
      path: "/state/accelerated-starts",
      cause: { code },
    });
    // When the inventory tries to discover journals.
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        return yield* acceleratedStartInventory.pipe(
          Effect.provideService(FileSystem, { ...fs, readDir: () => Effect.fail(failure) }),
          Effect.provide(store.layer),
        );
      }).pipe(Effect.provide(FileSystemLive)),
    );
    // Then only an absent directory is empty; other errors retain their original identity.
    if (code === "ENOTDIR") {
      expect(result).toEqual(Exit.succeed([]));
    } else {
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) expect(Option.getOrThrow(Cause.findErrorOption(result.cause))).toBe(failure);
    }
  },
);
