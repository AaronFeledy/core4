import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { AbsolutePath, type VolumeIdentity } from "@lando/sdk/schema";
import {
  DataMover,
  EventService,
  PathsService,
  RuntimeProvider,
  StateStore,
  type StateStoreShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { StateStoreLive } from "@lando/state-store/service";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { DataMoverLive } from "../src/service.ts";

test("the live shared port reads engine creation state and does not expose a creation writer", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mover-initialization-"));
  try {
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
    const store: StateStoreShape = {
      ...live,
      open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
    };
    const identity: VolumeIdentity = {
      coordinationKey: "daemon/data",
      nativeName: "data",
      generation: "one",
      ownerRoot: AbsolutePath.make("/owner"),
      origin: "created",
    };
    const engine = await Effect.runPromise(volumeInitialization(store, identity));
    await Effect.runPromise(engine.recordCreation);
    const mover = await Effect.runPromise(
      DataMover.pipe(
        Effect.provide(DataMoverLive),
        Effect.provideService(StateStore, store),
        Effect.provideService(PathsService, makeLandoPaths()),
        Effect.provideService(RuntimeProvider, TestRuntimeProvider),
        Effect.provideService(EventService, {
          publish: () => Effect.void,
          subscribe: () => Stream.empty,
          subscribeQueue: Effect.never,
          waitFor: () => Effect.never,
          waitForAny: () => Effect.never,
          query: () => Effect.succeed([]),
        }),
        Effect.provideService(RedactionService, {
          registerValues: registerRedactionValues,
          forProfile: () =>
            Effect.succeed({ redactString: (text: string) => text, redactValue: (value: unknown) => value }),
        }),
      ),
    );
    expect(mover.volumeInitialization).toBeDefined();
    if (!mover.volumeInitialization) throw new Error("live port missing");
    const shared = await Effect.runPromise(mover.volumeInitialization(identity));
    expect("recordCreation" in shared).toBe(false);
    expect((await Effect.runPromise(shared.read))?.state._tag).toBe("fresh");
    expect(await Effect.runPromise(shared.begin("sql"))).toBe(true);
    expect((await Effect.runPromise(engine.read))?.state._tag).toBe("in-progress");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
