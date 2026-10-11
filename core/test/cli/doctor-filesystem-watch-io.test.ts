import { expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { Effect, Fiber } from "effect";
import {
  FilesystemWatchIO,
  type WatchNativeIO,
  nativeWatchIO,
} from "../../src/cli/commands/doctor-filesystem-watch-io";

const systemError = (code: string) => Object.assign(new Error("private path"), { code });
const observe = (io: WatchNativeIO) =>
  FilesystemWatchIO.use((fs) => fs.observe).pipe(Effect.provide(FilesystemWatchIO.layerWith(io)));
const fixture = () => {
  const actions: string[] = [];
  const io: WatchNativeIO = {
    readLimit: async () => "1",
    makeDirectory: async () => {
      actions.push("mkdir");
      return "/unique";
    },
    watchDirectory: () => {
      actions.push("watch");
      return {
        close: () => {
          actions.push("close");
        },
      };
    },
    removeDirectory: async () => {
      actions.push("remove");
    },
  };
  return { io, actions };
};

test("closes the single watcher before removing its directory on success", async () => {
  // Given
  const { io, actions } = fixture();
  // When
  const result = await Effect.runPromise(observe(io));
  // Then
  expect(result.allocation).toEqual({ stage: "complete" });
  expect(actions).toEqual(["mkdir", "watch", "close", "remove"]);
});

test("removes the directory when watch acquisition fails", async () => {
  // Given
  const { io, actions } = fixture();
  // When
  const result = await Effect.runPromise(
    observe({
      ...io,
      watchDirectory: () => {
        throw systemError("ENOSPC");
      },
    }),
  );
  // Then
  expect(result.allocation).toEqual({ stage: "watch", errno: "ENOSPC" });
  expect(actions).toEqual(["mkdir", "remove"]);
});

test("attempts directory removal even if closing the watcher fails", async () => {
  // Given
  const { io, actions } = fixture();
  // When
  const result = await Effect.runPromise(
    observe({
      ...io,
      watchDirectory: () => ({
        close: () => {
          throw systemError("EIO");
        },
      }),
    }),
  );
  // Then
  expect(result).toMatchObject({ allocation: { stage: "cleanup" }, cleanup: "watch-close:EIO" });
  expect(actions).toEqual(["mkdir", "remove"]);
});

test("reports removal failure without hiding an earlier allocation failure", async () => {
  // Given
  const { io } = fixture();
  // When
  const result = await Effect.runPromise(
    observe({
      ...io,
      watchDirectory: () => {
        throw systemError("EMFILE");
      },
      removeDirectory: async () => {
        throw systemError("EACCES");
      },
    }),
  );
  // Then
  expect(result).toMatchObject({
    allocation: { stage: "watch", errno: "EMFILE" },
    cleanup: "directory-remove:EACCES",
  });
});

test("does not report success when directory cleanup fails after allocation", async () => {
  // Given
  const { io } = fixture();
  // When
  const result = await Effect.runPromise(
    observe({
      ...io,
      removeDirectory: async () => {
        throw systemError("EACCES");
      },
    }),
  );
  // Then
  expect(result).toMatchObject({ allocation: { stage: "cleanup" }, cleanup: "directory-remove:EACCES" });
});

test("keeps directory cleanup alive after interruption with the watcher already closed", async () => {
  // Given
  const { io, actions } = fixture();
  const removing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removed = Promise.withResolvers<void>();
  const fiber = Effect.runFork(
    observe({
      ...io,
      removeDirectory: async () => {
        removing.resolve();
        await release.promise;
        actions.push("remove");
        removed.resolve();
      },
    }),
  );
  await removing.promise;
  // When
  await Effect.runPromise(Fiber.interrupt(fiber));
  release.resolve();
  await removed.promise;
  // Then
  expect(actions).toEqual(["mkdir", "watch", "close", "remove"]);
});

test("cleans a late directory after interruption without allocating a watcher", async () => {
  // Given
  const { io, actions } = fixture();
  const started = Promise.withResolvers<void>();
  const acquired = Promise.withResolvers<string>();
  const removed = Promise.withResolvers<void>();
  const fiber = Effect.runFork(
    observe({
      ...io,
      makeDirectory: () => {
        started.resolve();
        return acquired.promise;
      },
      removeDirectory: async () => {
        actions.push("remove");
        removed.resolve();
      },
    }),
  );
  await started.promise;
  // When
  await Effect.runPromise(Fiber.interrupt(fiber));
  acquired.resolve("/late");
  await removed.promise;
  // Then
  expect(actions).toEqual(["remove"]);
});

test("interruption while reading limits prevents subsequent directory acquisition", async () => {
  // Given
  const { io, actions } = fixture();
  const started = Promise.withResolvers<void>();
  const read = Promise.withResolvers<string>();
  let reads = 0;
  const fiber = Effect.runFork(
    observe({
      ...io,
      readLimit: () => {
        reads++;
        started.resolve();
        return read.promise;
      },
    }),
  );
  await started.promise;
  // When
  await Effect.runPromise(Fiber.interrupt(fiber));
  read.resolve("1");
  await read.promise;
  // Then
  expect(reads).toBe(1);
  expect(actions).toEqual([]);
});

test.skipIf(process.platform !== "linux")(
  "native smoke allocates and cleans one real watch directory",
  async () => {
    // Given
    let directory = "";
    let closed = false;
    const io: WatchNativeIO = {
      ...nativeWatchIO,
      makeDirectory: async () => {
        directory = await nativeWatchIO.makeDirectory();
        return directory;
      },
      watchDirectory: (path, onError) => {
        const watcher = nativeWatchIO.watchDirectory(path, onError);
        return {
          close: () => {
            watcher.close();
            closed = true;
          },
        };
      },
    };
    // When
    const result = await Effect.runPromise(observe(io));
    // Then
    expect(result.allocation).toEqual({ stage: "complete" });
    expect(closed).toBe(true);
    expect(directory).not.toBe("");
    await access(directory).then(
      () => expect.unreachable("Probe directory was retained"),
      (error: unknown) => expect(error).toMatchObject({ code: "ENOENT" }),
    );
  },
);

test.skipIf(process.platform !== "linux")(
  "native watcher handles an asynchronous error during cleanup",
  async () => {
    // Given
    let emitError = () => {};
    const io: WatchNativeIO = {
      ...nativeWatchIO,
      watchDirectory: (path, onError) => {
        const watcher = nativeWatchIO.watchDirectory(path, onError);
        emitError = () => {
          watcher.emit("error", systemError("ENOSPC"));
        };
        return watcher;
      },
      removeDirectory: async (path) => {
        try {
          await Promise.resolve();
          emitError();
        } finally {
          await nativeWatchIO.removeDirectory(path);
        }
      },
    };
    // When
    const result = await Effect.runPromise(observe(io));
    // Then
    expect(result).toMatchObject({ allocation: { stage: "watch", errno: "ENOSPC" }, cleanup: "complete" });
  },
);
