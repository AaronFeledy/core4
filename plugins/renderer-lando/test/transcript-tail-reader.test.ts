import { mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { AbsolutePath } from "@lando/sdk/schema";

import { TranscriptTailReader, TranscriptTailReaderLive } from "../src/transcript-tail-reader.ts";

test("the scoped transcript reader pages backward and forward from the file tail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-transcript-tail-"));
  const path = AbsolutePath.make(join(directory, "step.log"));
  await writeFile(path, `${Array.from({ length: 8 }, (_, index) => `line-${index + 1}`).join("\r\n")}\r\n`);

  try {
    const pages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* TranscriptTailReader;
          const session = yield* reader.open(path, Effect.void);
          const latest = yield* session.read("latest", 3);
          const older = yield* session.read("older", 3);
          const resized = yield* session.read("refresh", 5);
          const newer = yield* session.read("newer", 3);
          return { latest, older, resized, newer };
        }).pipe(Effect.provide(TranscriptTailReaderLive)),
      ),
    );

    expect(pages.latest.lines).toEqual(["line-6", "line-7", "line-8"]);
    expect(pages.older.lines).toEqual(["line-3", "line-4", "line-5"]);
    expect(pages.resized.lines).toEqual(["line-1", "line-2", "line-3", "line-4", "line-5"]);
    expect(pages.newer.lines).toEqual(["line-6", "line-7", "line-8"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refresh recovers from transcript truncation and replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-transcript-tail-"));
  const path = AbsolutePath.make(join(directory, "step.log"));
  const replacement = join(directory, "replacement.log");
  await writeFile(path, "before-one\nbefore-two\n");

  try {
    const pages = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* TranscriptTailReader;
          const session = yield* reader.open(path, Effect.void);
          yield* session.read("latest", 4);
          yield* Effect.promise(() => writeFile(path, "truncated\n"));
          const truncated = yield* session.read("refresh", 4);
          yield* Effect.promise(() => writeFile(replacement, "replacement\n"));
          yield* Effect.promise(() => rename(replacement, path));
          const replaced = yield* session.read("refresh", 4);
          return { truncated, replaced };
        }).pipe(Effect.provide(TranscriptTailReaderLive)),
      ),
    );

    expect(pages.truncated.lines).toEqual(["truncated"]);
    expect(pages.replaced.lines).toEqual(["replacement"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded reads discard a partial first line and incomplete trailing UTF-8 code point", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-transcript-tail-"));
  const path = AbsolutePath.make(join(directory, "step.log"));
  const prefix = new TextEncoder().encode(`${"é".repeat(40_000)}\nvisible\n`);
  const content = new Uint8Array(prefix.length + 2);
  content.set(prefix);
  content.set([0xe2, 0x82], prefix.length);
  await writeFile(path, content);

  try {
    const page = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* TranscriptTailReader;
          const session = yield* reader.open(path, Effect.void);
          return yield* session.read("latest", 4);
        }).pipe(Effect.provide(TranscriptTailReaderLive)),
      ),
    );

    expect(page.lines).toEqual(["visible"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")("the reader rejects symlink transcript paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-transcript-tail-"));
  const target = join(directory, "target.log");
  const path = AbsolutePath.make(join(directory, "step.log"));
  await writeFile(target, "must not render\n");
  await symlink(target, path);

  try {
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* TranscriptTailReader;
          const session = yield* reader.open(path, Effect.void);
          return yield* Effect.exit(session.read("latest", 4));
        }).pipe(Effect.provide(TranscriptTailReaderLive)),
      ),
    );

    expect(exit._tag).toBe("Failure");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
