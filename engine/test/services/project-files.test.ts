import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Effect, Either } from "effect";

import { FileSystem } from "@lando/sdk/services";

import { loadServiceTypeProjectFiles } from "../../src/planner/project-files.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";

// Backslashes are separators only on Windows for this native-path loader.
const separators = sep === "\\" ? ["/", "\\"] : ["/"];

for (const separator of separators) {
  test.each(["packageRoot", "candidate"] as const)(
    `rejects %s traversal outside the app root with ${JSON.stringify(separator)} separators`,
    async (target) => {
      // Given a readable outside candidate, not merely a nonexistent path.
      const directory = await mkdtemp(join(tmpdir(), "lando-project-traversal-"));
      const appRoot = join(directory, "app");
      try {
        await mkdir(appRoot);
        await writeFile(join(directory, ".nvmrc"), "22.11.0\n");
        const outside = ["..", ".nvmrc"].join(separator);
        // When either the package root or the declaration escapes.
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem;
            return yield* Effect.either(
              loadServiceTypeProjectFiles({
                appRoot,
                serviceName: "web",
                packageRoot: target === "packageRoot" ? `..${separator}` : ".",
                declarations: [{ path: outside, maxBytes: 64 }],
                fileSystem,
              }),
            );
          }).pipe(Effect.provide(FileSystemLive)),
        );
        // Then containment fails in the typed error channel.
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("LandofileValidationError");
          expect(result.left.message).toContain("escapes the app root");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(["package ancestor", "package directory", "candidate ancestor", "candidate leaf"])(
    `rejects a symlinked %s with ${JSON.stringify(separator)} separators`,
    async (target) => {
      // Given a static symlink to a real, readable outside candidate.
      const directory = await mkdtemp(join(tmpdir(), "lando-project-symlink-"));
      const appRoot = join(directory, "app");
      const outside = join(directory, "outside");
      try {
        await mkdir(appRoot);
        await mkdir(join(outside, "nested"), { recursive: true });
        await writeFile(join(outside, ".nvmrc"), "22.11.0\n");
        await writeFile(join(outside, "nested", ".nvmrc"), "22.11.0\n");
        const leaf = target === "candidate leaf";
        await symlink(
          leaf ? join(outside, ".nvmrc") : outside,
          join(appRoot, "linked"),
          leaf ? "file" : "junction",
        );
        const packageRoot =
          target === "package ancestor"
            ? ["linked", "nested"].join(separator)
            : target === "package directory"
              ? "linked"
              : ".";
        const candidate = leaf ? "linked" : ["linked", "nested", ".nvmrc"].join(separator);
        // When the loader inspects the package or candidate path.
        const result = await Effect.runPromise(
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem;
            return yield* Effect.either(
              loadServiceTypeProjectFiles({
                appRoot,
                serviceName: "web",
                packageRoot,
                declarations: [{ path: candidate, maxBytes: 64 }],
                fileSystem,
              }),
            );
          }).pipe(Effect.provide(FileSystemLive)),
        );
        // Then no inference input is returned through the symlink.
        expect(Either.isLeft(result)).toBe(true);
        if (Either.isLeft(result)) {
          expect(result.left._tag).toBe("LandofileValidationError");
          expect(result.left.message).toContain("is a symbolic link");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}

test.each([
  { name: "oversize candidate", packageRoot: ".", maxBytes: 4, available: true, message: "read limit" },
  {
    name: "missing packageRoot directory",
    packageRoot: "missing",
    maxBytes: 64,
    available: true,
    message: "directory does not exist",
  },
  {
    name: "absent FileSystem service",
    packageRoot: ".",
    maxBytes: 64,
    available: false,
    message: "FileSystem service is unavailable",
  },
])("rejects $name as a typed failure", async ({ packageRoot, maxBytes, available, message }) => {
  // Given a real candidate and the requested invalid loading condition.
  const appRoot = await mkdtemp(join(tmpdir(), "lando-project-negative-"));
  try {
    await writeFile(join(appRoot, ".nvmrc"), "22.11.0\n");
    // When loading declared inference inputs.
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fileSystem = available ? yield* FileSystem : undefined;
        return yield* Effect.either(
          loadServiceTypeProjectFiles({
            appRoot,
            serviceName: "web",
            packageRoot,
            declarations: [{ path: ".nvmrc", maxBytes }],
            fileSystem,
          }),
        );
      }).pipe(Effect.provide(FileSystemLive)),
    );
    // Then the condition is rejected without an Effect defect or inferred data.
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe("LandofileValidationError");
      expect(result.left.message).toContain(message);
    }
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});

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
