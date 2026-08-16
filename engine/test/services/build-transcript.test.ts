import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

import { Effect } from "effect";

import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";

import { makeBuildTranscriptPath, openBuildTranscript } from "../../src/services/build-transcript.ts";

describe("makeBuildTranscriptPath", () => {
  test("contains branded identifiers within the builds root", () => {
    // Given
    const userDataRoot = resolve("/tmp/lando-data");

    // When
    const paths = [
      makeBuildTranscriptPath({
        userDataRoot,
        appId: "../../outside",
        phase: "artifact",
        serviceName: "../web",
        buildKey: "../../artifact",
        scratch: true,
      }),
      makeBuildTranscriptPath({
        userDataRoot,
        appId: "../../outside",
        phase: "app",
        serviceName: "../web",
        buildKey: "../../app",
        scratch: false,
      }),
    ];

    // Then
    const buildsRoot = resolve(userDataRoot, "builds");
    for (const path of paths) {
      expect(relative(buildsRoot, path).startsWith("..")).toBe(false);
    }
  });
});

describe("openBuildTranscript", () => {
  test.skipIf(process.platform === "win32")(
    "rejects an intermediate-directory symlink that escapes the user data root",
    async () => {
      // Given
      const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-"));
      const userDataRoot = resolve(root, "user-data");
      const escapeRoot = resolve(root, "escape");
      await mkdir(userDataRoot);
      await mkdir(escapeRoot);
      await symlink(escapeRoot, resolve(userDataRoot, "builds"));
      const path = makeBuildTranscriptPath({
        userDataRoot,
        appId: "test-app",
        phase: "app",
        serviceName: "web",
        buildKey: "test-build",
        scratch: false,
      });
      const escapeTarget = resolve(escapeRoot, "test-app", "app", "web", "test-build.log");

      try {
        // When
        const result = await Effect.runPromise(
          Effect.scoped(openBuildTranscript("test-provider", path, userDataRoot)).pipe(Effect.either),
        );

        // Then
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left).toBeInstanceOf(ProviderInternalError);
        expect(await Bun.file(escapeTarget).exists()).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "creates private transcript files and parent directories under a permissive umask",
    async () => {
      // Given
      const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-"));
      const path = AbsolutePath.make(resolve(root, "private", "nested", "build.log"));
      const previousUmask = process.umask(0);

      try {
        // When
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const transcript = yield* openBuildTranscript("test-provider", path, root);
              yield* transcript.append(new TextEncoder().encode("private output"));
            }),
          ),
        );

        // Then
        expect((await lstat(path)).mode & 0o777).toBe(0o600);
        expect((await lstat(resolve(root, "private"))).mode & 0o777).toBe(0o700);
        expect((await lstat(resolve(root, "private", "nested"))).mode & 0o777).toBe(0o700);
      } finally {
        process.umask(previousUmask);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "rejects a final-path symlink without truncating its target",
    async () => {
      // Given
      const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-"));
      const directory = resolve(root, "builds");
      const target = resolve(root, "target.log");
      const path = AbsolutePath.make(resolve(directory, "build.log"));
      await mkdir(directory);
      await writeFile(target, "preserve me");
      await symlink(target, path);

      try {
        // When
        const result = await Effect.runPromise(
          Effect.scoped(openBuildTranscript("test-provider", path, root)).pipe(Effect.either),
        );

        // Then
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left).toBeInstanceOf(ProviderInternalError);
        expect(await readFile(target, "utf8")).toBe("preserve me");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
