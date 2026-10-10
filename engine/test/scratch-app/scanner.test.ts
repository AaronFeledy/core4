import { expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { ScratchResourceScanner } from "../../src/scratch-app/scanner.ts";
import {
  emptyProvider,
  fixture,
  labels,
  runScanner,
  scratchId,
  service,
  unavailable,
  volume,
} from "./scanner-fixture.ts";

test("lists a nondefault-only orphan without its applied plan", async () => {
  // Given
  const { provider } = fixture();
  // When
  const ids = await runScanner([emptyProvider, provider], (scanner) => scanner.listScratchIds);
  // Then
  expect(ids).toEqual([scratchId]);
});

test("deduplicates scratch IDs across containers, volumes, and providers", async () => {
  // Given
  const first = fixture({ id: "first" });
  const second = fixture();
  // When
  const ids = await runScanner([first.provider, second.provider], (scanner) => scanner.listScratchIds);
  // Then
  expect(ids).toEqual([scratchId]);
});

test("prunes the same scratch ID on both providers using exact observations and generations", async () => {
  // Given
  const first = fixture({ id: "first" });
  const second = fixture();
  // When
  await runScanner([first.provider, second.provider], (scanner) => scanner.pruneScratch(scratchId));
  // Then
  for (const provider of [first, second]) {
    expect(provider.removedServices).toEqual(provider.services);
    expect(provider.removedVolumes).toEqual([
      {
        ref: provider.observedVolume.ref,
        generation: provider.observedVolume.identity.generation,
      },
    ]);
  }
});

test.each(["stopped", "unavailable", "availability failure", "status failure"])(
  "skips a %s provider and continues scanning other runtimes",
  async (state) => {
    // Given
    const skipped = fixture({
      id: "skipped",
      isAvailable:
        state === "availability failure" ? Effect.fail(unavailable) : Effect.succeed(state !== "unavailable"),
      getStatus:
        state === "status failure"
          ? Effect.fail(unavailable)
          : Effect.succeed({ running: false, message: "stopped" }),
      list: () => Effect.die("offline runtime must not be listed"),
      listVolumes: () => Effect.die("offline runtime must not be listed"),
    });
    const active = fixture();
    // When
    const ids = await runScanner([skipped.provider, active.provider], (scanner) => scanner.listScratchIds);
    // Then
    expect(ids).toEqual([scratchId]);
  },
);

test("protects invalid IDs, unlabeled resources, and app/label mismatches", async () => {
  // Given
  const { provider, removedServices, removedVolumes } = fixture({
    list: () =>
      Effect.succeed([
        { ...service, labels: {} },
        { ...service, labels: { ...labels, "dev.lando.scratch-id": "registry.bin" } },
        { ...service, app: AppId.make("normal-app") },
      ]),
    listVolumes: () =>
      Effect.succeed([
        { ...volume, labels: {} },
        { ...volume, labels: { ...labels, "dev.lando.scratch-id": "../scratch-unsafe" } },
      ]),
  });
  // When
  const ids = await runScanner([provider], (scanner) =>
    scanner.listScratchIds.pipe(Effect.tap(() => scanner.pruneScratch(scratchId))),
  );
  // Then
  expect(ids).toEqual([]);
  expect(removedServices).toEqual([]);
  expect(removedVolumes).toEqual([]);
});

test("ignores invalid prune IDs without observing providers", async () => {
  // Given
  const { provider } = fixture({ list: () => Effect.die("invalid ID must not trigger a scan") });
  // When / Then
  await runScanner([provider], (scanner) => scanner.pruneScratch("registry.bin"));
});

test("prevalidates volume identities on every provider before deleting any resource", async () => {
  // Given
  const first = fixture({ id: "first" });
  const second = fixture({ listVolumes: () => Effect.succeed([{ ref: volume.ref, labels }]) });
  // When
  const result = await runScanner([first.provider, second.provider], (scanner) =>
    scanner.pruneScratch(scratchId).pipe(Effect.result),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ScratchAppError", operation: "gc" } });
  expect([
    ...first.removedServices,
    ...first.removedVolumes,
    ...second.removedServices,
    ...second.removedVolumes,
  ]).toEqual([]);
});

test.each(["list", "listVolumes"] as const)(
  "surfaces %s failures instead of a clean scan",
  async (operation) => {
    // Given
    const broken = fixture({ [operation]: () => Effect.fail(unavailable) });
    // When
    const result = await runScanner([emptyProvider, broken.provider], (scanner) =>
      scanner.listScratchIds.pipe(Effect.result),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ScratchAppError", cause: unavailable },
    });
  },
);

test.each(["list", "listVolumes", "removeObservedService", "removeVolume"] as const)(
  "surfaces %s failures when pruning",
  async (operation) => {
    // Given
    const first = fixture({ id: "first" });
    const broken = fixture({ [operation]: () => Effect.fail(unavailable) });
    // When
    const result = await runScanner([first.provider, broken.provider], (scanner) =>
      scanner.pruneScratch(scratchId).pipe(Effect.result),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ScratchAppError", cause: unavailable },
    });
    if (operation === "list" || operation === "listVolumes") {
      expect([...first.removedServices, ...first.removedVolumes]).toEqual([]);
    }
  },
);

test("keeps no-registry scanning and pruning inert", async () => {
  // Given / When
  const ids = await Effect.runPromise(
    Effect.flatMap(ScratchResourceScanner, (scanner) =>
      scanner.pruneScratch(scratchId).pipe(Effect.andThen(scanner.listScratchIds)),
    ).pipe(Effect.provide(ScratchResourceScanner.layer)),
  );
  // Then
  expect(ids).toEqual([]);
});
