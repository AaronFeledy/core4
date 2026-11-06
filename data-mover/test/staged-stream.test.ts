import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { RedactionService } from "@lando/redaction/service";
import { DataTransferError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { DataMover, EventService, PathsService, StateStore } from "@lando/sdk/services";
import {
  type PrivateFileAccess,
  PrivateFileAccessError,
  PrivateFileAccessService,
} from "@lando/state-store/private-file-access";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect, Layer, Stream } from "effect";
import { layerWithPrivateFileAccess } from "../src/service.ts";
import { stageVerifiedStream } from "../src/staged-stream.ts";
import { privateFileAccess } from "./private-file-access.ts";
import { registryLayer } from "./support.ts";

for (const existing of [false, true]) {
  test.skipIf(process.platform === "win32")(
    `staging uses 0700 directories and 0600 files (${existing ? "existing" : "new"} directory)`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lando-private-stage-"));
      const directory = join(root, "transfer-staging");
      try {
        if (existing) {
          await mkdir(directory);
          await chmod(directory, 0o755);
        }
        await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const staged = yield* stageVerifiedStream({
                body: Stream.make(new TextEncoder().encode("private payload")),
                transferStagingDir: directory,
                prefix: "test",
                privateFileAccess,
              });
              expect((yield* Effect.promise(() => stat(directory))).mode & 0o777).toBe(0o700);
              expect((yield* Effect.promise(() => stat(staged.path))).mode & 0o777).toBe(0o600);
              expect(yield* Effect.promise(() => readFile(staged.path, "utf8"))).toBe("private payload");
            }),
          ),
        );
        expect(await readdir(directory)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test("injected Windows ACL access enforces and verifies the directory and empty file before payload writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-stage-acl-"));
  const directory = join(root, "transfer-staging");
  const enforced = new Set<string>();
  const verified = new Set<string>();
  let filePath: string | undefined;
  const access: PrivateFileAccess = {
    enforce: async (path) => {
      const info = await stat(path);
      if (path !== directory) {
        expect(verified.has(directory)).toBe(true);
        expect(info.size).toBe(0);
        filePath = path;
      }
      enforced.add(path);
    },
    verify: async (path) => {
      expect(enforced.has(path)).toBe(true);
      if (path !== directory) expect((await stat(path)).size).toBe(0);
      verified.add(path);
    },
  };
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const staged = yield* stageVerifiedStream({
            body: Stream.fromEffect(
              Effect.sync(() => {
                expect(filePath).toBeDefined();
                expect(verified.has(filePath ?? "")).toBe(true);
                return new TextEncoder().encode("secret dump");
              }),
            ),
            transferStagingDir: directory,
            prefix: "windows",
            privateFileAccess: access,
          });
          expect(yield* Effect.promise(() => readFile(staged.path, "utf8"))).toBe("secret dump");
        }),
      ),
    );
    expect(verified.size).toBe(2);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["directory-enforce", "directory-verify", "file-enforce", "file-verify"]) {
  test(`DataMover fails closed with a typed error on Windows ACL ${failure} failure`, async () => {
    const root = await mkdtemp(join(process.cwd(), ".tmp-stage-denied-"));
    const paths = makeLandoPaths({ userCacheRoot: root });
    const source = join(root, "source");
    const target = join(root, "target.tar");
    let checkedSize: number | undefined;
    const check = async (operation: string, path: string) => {
      const kind = path === paths.transferStagingDir ? "directory" : "file";
      if (`${kind}-${operation}` === failure) {
        if (kind === "file") checkedSize = (await stat(path)).size;
        throw new PrivateFileAccessError(path);
      }
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(PrivateFileAccessService, {
        enforce: (path) => check("enforce", path),
        verify: (path) => check("verify", path),
      }),
      Layer.succeed(PathsService, { ...paths, scratchDir: root }),
      Layer.succeed(StateStore, makeTestStateStore().service),
      registryLayer,
      RedactionService.layer,
      Layer.succeed(
        EventService,
        EventService.of({
          publish: () => Effect.void,
          subscribe: () => Stream.empty,
          subscribeQueue: Effect.never,
          waitFor: () => Effect.never,
          subscribeWithHistory: () => Effect.never,
          waitForAny: () => Effect.never,
          query: () => Effect.succeed([]),
        }),
      ),
    );
    try {
      await writeFile(source, "sensitive source bytes");
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.flatMap(DataMover, (mover) =>
            mover.transfer({
              from: { _tag: "hostPath", path: AbsolutePath.make(source) },
              to: { _tag: "hostArchive", path: AbsolutePath.make(target), format: "tar" },
              overwrite: true,
            }),
          ),
        ).pipe(Effect.provide(layerWithPrivateFileAccess.pipe(Layer.provide(dependencies))), Effect.flip),
      );
      expect(error).toBeInstanceOf(DataTransferError);
      expect(await readdir(paths.transferStagingDir)).toEqual([]);
      expect(await Bun.file(target).exists()).toBe(false);
      if (failure.startsWith("file-")) expect(checkedSize).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
