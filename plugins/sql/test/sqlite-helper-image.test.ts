import { expect, test } from "bun:test";
import { sqliteHelperImage } from "@lando/container-runtime/data-plane";
import { SqlRecoveryUnavailableError } from "@lando/sdk/errors";
import { Effect, Exit } from "effect";
import { resolveSqliteHelperImage } from "../src/sqlite-helper.ts";

test.each([undefined, "sha256:wrong", sqliteHelperImage.digest])(
  "requires the pinned pulled SQLite digest (%s)",
  async (digest) => {
    const result = await Effect.runPromiseExit(
      resolveSqliteHelperImage({
        pullArtifact: () => Effect.succeed(digest === undefined ? {} : { digest }),
      }),
    );
    expect(Exit.isSuccess(result)).toBe(digest === sqliteHelperImage.digest);
    if (Exit.isFailure(result)) expect(String(result.cause)).toContain(SqlRecoveryUnavailableError.name);
  },
);
