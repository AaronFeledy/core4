import { expect, test } from "bun:test";
import { Effect, Either, Stream } from "effect";

import { FileSystem } from "@lando/sdk/services";
import { loadServiceTypeProjectFiles } from "../../src/planner/project-files.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

test.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, 1.5])(
  "rejects maxBytes %s before filesystem access",
  async (maxBytes) => {
    // Given a malformed SDK declaration, including an omitted required property.
    const declaration = { path: ".nvmrc", maxBytes: 64 };
    if (maxBytes === undefined) Reflect.deleteProperty(declaration, "maxBytes");
    else declaration.maxBytes = maxBytes;
    const accesses: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const live = yield* FileSystem;
        // When loading the declaration through the public planner boundary.
        return yield* Effect.either(
          loadServiceTypeProjectFiles({
            appRoot: "/app",
            serviceName: "web",
            packageRoot: ".",
            declarations: [declaration],
            fileSystem: {
              ...live,
              lstat: (path) => {
                accesses.push("lstat");
                return live.lstat(path);
              },
              read: (path) => {
                accesses.push("read");
                return live.read(path);
              },
            },
          }),
        );
      }).pipe(Effect.provide(FileSystemLive)),
    );
    // Then rejection is typed and happens before even inspecting a path.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileValidationError");
      expect(result.left.message).toContain("maxBytes");
    }
    expect(accesses).toEqual([]);
  },
);

test.each(["stat", "stream"] as const)("clamps large valid limits at the %s size check", async (check) => {
  // Given a declaration above 1 MiB and a file one byte over the hard cap.
  let reads = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const live = yield* FileSystem;
      // When metadata or streamed bytes exceed the cap.
      return yield* Effect.either(
        loadServiceTypeProjectFiles({
          appRoot: "/app",
          serviceName: "web",
          packageRoot: ".",
          declarations: [{ path: ".nvmrc", maxBytes: 2_097_152 }],
          fileSystem: {
            ...live,
            lstat: (path) =>
              Effect.succeed({
                isDirectory: path === "/app",
                isFile: path !== "/app",
                isSymbolicLink: false,
                mtimeMs: 0,
                size: check === "stat" ? 1_048_577 : 0,
              }),
            read: () => {
              reads++;
              return Stream.make(new Uint8Array(1_048_577));
            },
          },
        }),
      );
    }).pipe(Effect.provide(FileSystemLive)),
  );
  // Then neither size check accepts bytes beyond the planner-owned limit.
  expect(Either.isLeft(result)).toBe(true);
  if (Either.isLeft(result)) {
    expect(result.left._tag).toBe("LandofileValidationError");
    expect(result.left.message).toContain("1048576-byte read limit");
  }
  expect(reads).toBe(check === "stat" ? 0 : 1);
});
