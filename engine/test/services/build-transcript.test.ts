import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { ProviderInternalError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect } from "effect";

import {
  buildTranscriptExists,
  makeBuildTranscriptPath,
  openBuildTranscript,
  readBuildTranscriptLines,
  readTailBytes,
} from "../../src/services/build-transcript.ts";

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
          Effect.scoped(openBuildTranscript("test-provider", path, userDataRoot)).pipe(Effect.result),
        );

        // Then
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProviderInternalError);
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
          Effect.scoped(openBuildTranscript("test-provider", path, root)).pipe(Effect.result),
        );

        // Then
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") expect(result.failure).toBeInstanceOf(ProviderInternalError);
        expect(await readFile(target, "utf8")).toBe("preserve me");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

const readTranscript = (
  userDataRoot: string,
  appDir: string,
  path: string,
  tail?: number,
): Promise<ReadonlyArray<string> | undefined> =>
  Effect.runPromise(
    readBuildTranscriptLines({
      providerId: "test-provider",
      userDataRoot,
      appDir,
      path: AbsolutePath.make(path),
      ...(tail === undefined ? {} : { tail }),
    }),
  );

describe("readBuildTranscriptLines", () => {
  test("reads every line, or only the last N, counting an unterminated last line", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-read-"));
    const appDir = resolve(root, "builds", "test-app");
    const transcript = resolve(appDir, "app", "web", "read.log");
    await mkdir(resolve(appDir, "app", "web"), { recursive: true });
    await writeFile(transcript, "one\ntwo\nthree\nfour");

    try {
      // When
      const all = await readTranscript(root, appDir, transcript);
      const tail = await readTranscript(root, appDir, transcript, 2);

      // Then
      expect(all).toEqual(["one", "two", "three", "four"]);
      expect(tail).toEqual(["three", "four"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps a multi-byte character whole when the read window would split it", async () => {
    // Given a transcript whose last line starts with a two-byte character 8192 bytes from the end.
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-read-"));
    const appDir = resolve(root, "builds", "test-app");
    const transcript = resolve(appDir, "app", "web", "multibyte.log");
    await mkdir(resolve(appDir, "app", "web"), { recursive: true });
    const last = `\u00e9${"z".repeat(8190)}`;
    const content = `p\n${last}\n`;
    expect(Buffer.byteLength(content)).toBe(8195);
    await writeFile(transcript, content);

    try {
      // When
      const tail = await readTranscript(root, appDir, transcript, 1);
      const all = await readTranscript(root, appDir, transcript);

      // Then
      expect(tail).toEqual([last]);
      expect(all).toEqual(["p", last]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("skips a missing transcript and a path outside the app directory", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-read-"));
    const appDir = resolve(root, "builds", "test-app");
    await mkdir(appDir, { recursive: true });
    const outside = resolve(root, "outside.log");
    await writeFile(outside, "not a transcript\n");

    try {
      // When
      const missing = await readTranscript(root, appDir, resolve(appDir, "missing.log"));
      const escaped = await readTranscript(root, appDir, outside);

      // Then
      expect(missing).toBeUndefined();
      expect(escaped).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("skips a transcript that is a symbolic link", async () => {
    // Given
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-read-"));
    const appDir = resolve(root, "builds", "test-app");
    const directory = resolve(appDir, "app", "web");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "real.log"), "real\n");
    const link = resolve(directory, "link.log");
    await symlink(resolve(directory, "real.log"), link);

    try {
      // When
      const lines = await readTranscript(root, appDir, link);

      // Then
      expect(lines).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "skips an app directory that resolves outside the data root",
    async () => {
      // Given a `builds/test-app` directory replaced by a symlink to an outside directory.
      const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-read-"));
      const userDataRoot = resolve(root, "data");
      const outside = resolve(root, "outside");
      await mkdir(resolve(userDataRoot, "builds"), { recursive: true });
      await mkdir(outside);
      const outsideTranscript = resolve(outside, "device.log");
      await writeFile(outsideTranscript, "outside output\n");
      const appDir = resolve(userDataRoot, "builds", "test-app");
      await symlink(outside, appDir);
      const recorded = resolve(appDir, "device.log");

      try {
        // When
        const lines = await readTranscript(userDataRoot, appDir, recorded);

        // Then the recorded path and the app directory agree while both resolve outside; the
        // app directory itself is checked against the data root before anything is opened.
        expect(lines).toBeUndefined();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("stops reading once the tail window holds the requested lines", async () => {
    // Given a large transcript of short lines; ten-byte lines and a five-byte final line keep
    // every 32-byte chunk boundary off a line boundary.
    const content = Buffer.from(`${"abcdefghi\n".repeat(10_000)}last!`);
    let bytesRead = 0;

    // When the last line is read backwards in 32-byte chunks.
    const data = await readTailBytes(
      async (position, length) => {
        bytesRead += length;
        return content.subarray(position, position + length);
      },
      content.length,
      1,
      32,
    );

    // Then one chunk was enough, and the window ends with the requested line.
    expect(data.toString("utf8").split("\n").at(-1)).toBe("last!");
    expect(bytesRead).toBe(32);
  });

  test("reads an unterminated last line from a bounded window that never aligns to the chunk size", async () => {
    // Given three-byte lines that no 16-byte chunk boundary matches, and no trailing newline.
    const content = Buffer.from(`${"ab\n".repeat(2_000)}last!`);
    let bytesRead = 0;

    // When
    const data = await readTailBytes(
      async (position, length) => {
        bytesRead += length;
        return content.subarray(position, position + length);
      },
      content.length,
      2,
      16,
    );

    // Then the unterminated line counts as a line and the window stayed bounded.
    expect(data.toString("utf8").split("\n").slice(-2)).toEqual(["ab", "last!"]);
    expect(bytesRead).toBe(16);
  });
});

describe("buildTranscriptExists", () => {
  test("advertises only a regular file", async () => {
    // Given a regular transcript, a directory, and a missing path.
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-exists-"));
    const regular = resolve(root, "regular.log");
    await writeFile(regular, "output\n");
    await mkdir(resolve(root, "directory"));

    try {
      // When / Then
      expect(await Effect.runPromise(buildTranscriptExists(AbsolutePath.make(regular)))).toBe(true);
      expect(
        await Effect.runPromise(buildTranscriptExists(AbsolutePath.make(resolve(root, "directory")))),
      ).toBe(false);
      expect(
        await Effect.runPromise(buildTranscriptExists(AbsolutePath.make(resolve(root, "missing.log")))),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("does not advertise a symlink to a regular file", async () => {
    // Given a recorded transcript path replaced by a symlink to the real file.
    const root = await mkdtemp(resolve(tmpdir(), "lando-build-transcript-exists-"));
    const real = resolve(root, "real.log");
    const link = resolve(root, "recorded.log");
    await writeFile(real, "output\n");
    await symlink(real, link);

    try {
      // When / Then
      expect(await Effect.runPromise(buildTranscriptExists(AbsolutePath.make(link)))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
