import { expect, test } from "bun:test";
import { VolumeOperationError } from "@lando/sdk/errors";
import { ProviderId } from "@lando/sdk/schema";
import { Deferred, Effect } from "effect";
import { fixture, runScanner, scratchId, service, volume } from "./scanner-fixture.ts";

test.each([
  { shared: true, expected: ["docker"] },
  { shared: false, expected: ["docker", "podman"] },
])("deletes physical scratch volumes once when shared=$shared", async ({ shared, expected }) => {
  // Given: adapter IDs are not physical runtime identities; generations can match across daemons.
  const dockerVolume = {
    ...volume,
    labels: { ...volume.labels, "dev.lando.provider": "docker" },
    identity: {
      ...volume.identity,
      coordinationKey: JSON.stringify(["endpoint:unix:///runtime-a/podman.sock", volume.identity.nativeName]),
    },
  };
  const podmanVolume = shared
    ? dockerVolume
    : {
        ...dockerVolume,
        identity: {
          ...dockerVolume.identity,
          coordinationKey: JSON.stringify([
            "endpoint:unix:///runtime-b/podman.sock",
            volume.identity.nativeName,
          ]),
        },
      };
  const remaining = new Set([dockerVolume.identity.coordinationKey, podmanVolume.identity.coordinationKey]);
  const removals: string[] = [];
  const providers = [
    { id: "docker", observed: dockerVolume },
    { id: "podman", observed: podmanVolume },
  ].map(
    ({ id, observed }) =>
      fixture({
        id,
        list: () => Effect.succeed([]),
        listVolumes: () => Effect.succeed([observed]),
        removeVolume: (ref, generation) =>
          Effect.suspend(() => {
            expect(ref).toEqual(observed.ref);
            expect(generation).toBe(observed.identity.generation);
            removals.push(id);
            return remaining.delete(observed.identity.coordinationKey)
              ? Effect.void
              : Effect.fail(
                  new VolumeOperationError({
                    providerId: id,
                    operation: "removeVolume",
                    message: "Observed volume generation is already absent",
                  }),
                );
          }),
      }).provider,
  );

  // When
  const result = await runScanner(providers, (scanner) =>
    scanner.pruneScratch(scratchId).pipe(Effect.result),
  );

  // Then: one deletion through the retained observing adapter per physical identity, without hiding errors.
  expect(result._tag).toBe("Success");
  expect(removals).toEqual([...expected]);
});

test("keeps different observed generations eligible for provider validation", async () => {
  // Given
  const generations: string[] = [];
  const providers = ["docker", "podman"].map(
    (id) =>
      fixture({
        id,
        list: () => Effect.succeed([]),
        listVolumes: () =>
          Effect.succeed([
            {
              ...volume,
              identity: { ...volume.identity, generation: `${id}-generation` },
            },
          ]),
        removeVolume: (_ref, generation) =>
          Effect.sync(() => {
            generations.push(generation);
          }),
      }).provider,
  );
  // When
  await runScanner(providers, (scanner) => scanner.pruneScratch(scratchId));
  // Then
  expect(generations).toEqual(["docker-generation", "podman-generation"]);
});

test.each([{ fails: false }, { fails: true }])(
  "finishes the container phase before volumes when container failure=$fails",
  async ({ fails }) => {
    // Given
    const remaining = new Set(["docker", "podman"]);
    const events: string[] = [];
    const failure = new VolumeOperationError({ providerId: "podman", operation: "test", message: "refused" });
    const providers = ["docker", "podman"].map(
      (id) =>
        fixture({
          id,
          list: () => Effect.succeed([{ ...service, providerId: ProviderId.make(id), containerId: id }]),
          listVolumes: () => Effect.succeed([volume]),
          removeObservedService: (observed) =>
            Effect.suspend(() => {
              expect(observed.containerId).toBe(id);
              if (fails && id === "podman") return Effect.fail(failure);
              remaining.delete(id);
              events.push(`container:${id}`);
              return Effect.succeed({ kind: "removed" as const });
            }),
          removeVolume: () =>
            Effect.suspend(() => {
              events.push(`volume:${id}`);
              if (remaining.size > 0) return Effect.fail(failure);
              return Effect.void;
            }),
        }).provider,
    );
    // When
    const result = await runScanner(providers, (scanner) =>
      scanner.pruneScratch(scratchId).pipe(Effect.result),
    );
    // Then
    if (fails) {
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ScratchAppError", cause: failure } });
      expect(events.filter((event) => event.startsWith("volume:"))).toEqual([]);
    } else {
      expect(result._tag).toBe("Success");
      expect(events.slice(0, 2).sort()).toEqual(["container:docker", "container:podman"]);
      expect(events.slice(2)).toEqual(["volume:docker"]);
    }
  },
);

test("inventories independent providers concurrently with cancellation on timeout", async () => {
  // Given
  const secondStarted = Effect.runSync(Deferred.make<void>());
  let firstSettled = false;
  const first = fixture({
    id: "first",
    list: () =>
      Deferred.await(secondStarted).pipe(
        Effect.as([service]),
        Effect.ensuring(
          Effect.sync(() => {
            firstSettled = true;
          }),
        ),
      ),
  });
  const second = fixture({
    id: "second",
    list: () => Deferred.succeed(secondStarted, undefined).pipe(Effect.as([service])),
  });
  // When
  const result = await runScanner([first.provider, second.provider], (scanner) =>
    scanner.listScratchIds.pipe(Effect.timeout("1 second"), Effect.result),
  );
  // Then
  expect(firstSettled).toBe(true);
  expect(result).toMatchObject({ _tag: "Success", success: [scratchId] });
});
