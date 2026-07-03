import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Chunk, Effect, Layer, Queue } from "effect";

import type { ManagedFile } from "@lando/sdk/schema";
import { EventService, ManagedFileService } from "@lando/sdk/services";

import { ManagedFileServiceLive } from "../../src/managed-file/service.ts";
import { RedactionServiceLive } from "../../src/redaction/service.ts";
import { EventServiceLive } from "../../src/services/event-service.ts";
import { makeTestSecretStore } from "../../src/testing/secret-store.ts";

const file = (base: ManagedFile["base"], owner: string): ManagedFile => ({
  id: "cms:settings",
  owner,
  mode: "file",
  format: "text",
  base,
  path: "settings.txt" as ManagedFile["path"],
  content: { kind: "text", value: "hello world\n" },
});

describe("ManagedFile env redaction", () => {
  test("env-derived secrets outside SecretStore are masked in event payload fields", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-env-base-")));
    const dataRoot = await realpath(await mkdtemp(join(tmpdir(), "lando-mfe-env-data-")));
    const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
    const previousToken = process.env.API_TOKEN;
    const secret = "plain-env-owned-value";
    process.env.LANDO_USER_DATA_ROOT = dataRoot;
    process.env.API_TOKEN = secret;

    try {
      const emptySecretStore = makeTestSecretStore();
      const redactionLive = RedactionServiceLive.pipe(Layer.provide(emptySecretStore.layer));
      const layer = Layer.mergeAll(
        EventServiceLive,
        ManagedFileServiceLive.pipe(Layer.provide(Layer.mergeAll(EventServiceLive, redactionLive))),
      );

      const collected = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const eventService = yield* EventService;
            const queue = yield* eventService.subscribeQueue;
            const managed = yield* ManagedFileService;
            yield* managed.apply([file(base as ManagedFile["base"], secret)]);
            yield* Effect.sleep("25 millis");
            const drained = yield* Queue.takeAll(queue);
            return Chunk.toReadonlyArray(drained);
          }).pipe(Effect.provide(layer)),
        ),
      );

      const managedEvents = collected.filter((event) => String(event._tag).includes("managed-file"));
      expect(managedEvents.length).toBeGreaterThan(0);
      for (const event of managedEvents) {
        expect(event.owner).toBe("[redacted]");
      }
      expect(JSON.stringify(collected)).not.toContain(secret);
    } finally {
      if (previousDataRoot === undefined) {
        process.env.LANDO_USER_DATA_ROOT = "";
        Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
      } else {
        process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
      }
      if (previousToken === undefined) {
        process.env.API_TOKEN = "";
        Reflect.deleteProperty(process.env, "API_TOKEN");
      } else {
        process.env.API_TOKEN = previousToken;
      }
      await rm(base, { recursive: true, force: true });
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
