import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventService, type LandoEvent } from "@lando/sdk/services";
import { Effect, Queue, Stream } from "effect";

export const withBunScript = async <T>(content: string, run: (root: string) => Promise<T>): Promise<T> => {
  const root = await mkdtemp(join(tmpdir(), "lando-script-input-"));
  try {
    await mkdir(join(root, ".lando/scripts"), { recursive: true });
    await writeFile(join(root, ".lando/scripts/probe.bun.sh"), content);
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

export const recordingScriptEvents = (events: LandoEvent[]) =>
  EventService.of({
    publish: (event: LandoEvent) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Queue.unbounded<never>(),
    waitFor: () => Effect.never,
    subscribeWithHistory: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed([]),
  });
