import { describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { openAppBuildResults, recordBuildResult } from "../../src/services/build-results.ts";
import {
  removeBuildTranscripts,
  sweepAppBuildTranscripts,
} from "../../src/services/build-transcript-cleanup.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const withRoot = async <T>(run: (root: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-build-cleanup-")));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("sweepAppBuildTranscripts", () => {
  test("keeps a referenced transcript whose recorded root is spelled differently", async () => {
    await withRoot(async (root) => {
      // Given a transcript on disk and an index entry with the same service dir and file name but
      // a different user data root spelling (a symlinked home, a different env variable spelling).
      const store = makeTestStateStore();
      const appId = "app";
      const transcript = join(root, "builds", appId, "app", "web", "key.log");
      await mkdir(dirname(transcript), { recursive: true });
      await writeFile(transcript, "output\n");
      const bucket = await Effect.runPromise(openAppBuildResults(store.service, appId));
      await Effect.runPromise(
        recordBuildResult(bucket, {
          buildKey: "key",
          service: ServiceName.make("web"),
          phase: "app",
          step: "web:app:install",
          outcome: "complete",
          exitCode: 0,
          durationMs: 1,
          transcriptPath: AbsolutePath.make(
            join("/symlinked-home/lando", "builds", appId, "app", "web", "key.log"),
          ),
        }),
      );

      // When
      await Effect.runPromise(
        sweepAppBuildTranscripts({
          stateStore: store.service,
          appId,
          scratch: false,
          phase: "app",
          userDataRoot: root,
          redact: (text) => text,
        }),
      );

      // Then
      expect(await Bun.file(transcript).exists()).toBe(true);
    });
  });

  test("sweeps a scratch app phase against the per-app index", async () => {
    await withRoot(async (root) => {
      // Given a scratch app with one referenced app-step transcript and one stale transcript.
      const store = makeTestStateStore();
      const appId = "scratch-demo-123456";
      const directory = join(root, "builds", "scratch", appId, "app", "web");
      const referenced = join(directory, "install.log");
      const stale = join(directory, "stale.log");
      await mkdir(directory, { recursive: true });
      await writeFile(referenced, "install output\n");
      await writeFile(stale, "stale output\n");
      const bucket = await Effect.runPromise(openAppBuildResults(store.service, appId));
      await Effect.runPromise(
        recordBuildResult(bucket, {
          buildKey: "install",
          service: ServiceName.make("web"),
          phase: "app",
          step: "web:app:install",
          outcome: "complete",
          exitCode: 0,
          durationMs: 1,
          transcriptPath: AbsolutePath.make(referenced),
        }),
      );

      // When the scratch app phase is swept.
      await Effect.runPromise(
        sweepAppBuildTranscripts({
          stateStore: store.service,
          appId,
          scratch: true,
          phase: "app",
          userDataRoot: root,
          redact: (text) => text,
        }),
      );

      // Then the shared image index never decides the app phase: the app's own entry is consulted.
      expect(await Bun.file(referenced).exists()).toBe(true);
      expect(await Bun.file(stale).exists()).toBe(false);
    });
  });
});

describe("removeBuildTranscripts", () => {
  test.skipIf(process.platform === "win32")(
    "does not unlink an app entry whose parent symlinks outside the data root",
    async () => {
      await withRoot(async (root) => {
        // Given a `builds` directory that is a symlink to an outside directory holding a file
        // named after the app.
        const userDataRoot = join(root, "data");
        const outside = join(root, "outside");
        await mkdir(userDataRoot);
        await mkdir(outside);
        const victim = join(outside, "app");
        await writeFile(victim, "keep me\n");
        await symlink(outside, join(userDataRoot, "builds"));

        // When the app's build output is removed.
        await Effect.runPromise(
          removeBuildTranscripts({ userDataRoot, appId: "app", scratch: false, providerId: "test" }),
        );

        // Then the outside file survives: the unlink branch checks its parent first.
        expect(await readFile(victim, "utf8")).toBe("keep me\n");
      });
    },
  );

  test.skipIf(process.platform === "win32")(
    "unlinks a symlink at the app path without following it",
    async () => {
      await withRoot(async (root) => {
        // Given an app path that is a symlink to a directory outside the data root.
        const userDataRoot = join(root, "data");
        const outside = join(root, "outside");
        await mkdir(join(userDataRoot, "builds"), { recursive: true });
        await mkdir(outside);
        const insideOutside = join(outside, "transcript.log");
        await writeFile(insideOutside, "outside output\n");
        const appDir = join(userDataRoot, "builds", "app");
        await symlink(outside, appDir);

        // When the app's build output is removed.
        await Effect.runPromise(
          removeBuildTranscripts({ userDataRoot, appId: "app", scratch: false, providerId: "test" }),
        );

        // Then the link itself is gone and its target is untouched.
        await expect(lstat(appDir)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(insideOutside, "utf8")).toBe("outside output\n");
      });
    },
  );
});
