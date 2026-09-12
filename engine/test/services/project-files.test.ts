import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Either } from "effect";

import { FileSystem } from "@lando/sdk/services";

import { loadServiceTypeProjectFiles } from "../../src/planner/project-files.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

test("reports project traversal as a typed failure rather than an Effect defect", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem;
      return yield* Effect.either(
        loadServiceTypeProjectFiles({
          appRoot: "/app",
          serviceName: "web",
          packageRoot: "../outside",
          declarations: [{ path: "../outside/.nvmrc", maxBytes: 1_048_576 }],
          fileSystem,
        }),
      );
    }).pipe(Effect.provide(FileSystemLive)),
  );

  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) expect(result.left._tag).toBe("LandofileValidationError");
});

test("fingerprints original file bytes including a UTF-8 BOM", async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-project-file-bytes-"));
  const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("22.11.0\n")]);
  try {
    await writeFile(join(appRoot, ".nvmrc"), bytes);
    const files = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem;
        return yield* loadServiceTypeProjectFiles({
          appRoot,
          serviceName: "web",
          packageRoot: ".",
          declarations: [{ path: ".nvmrc", maxBytes: 1_048_576 }],
          fileSystem,
        });
      }).pipe(Effect.provide(FileSystemLive)),
    );

    expect(files[0]).toMatchObject({
      present: true,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
