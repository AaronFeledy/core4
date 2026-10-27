import { expect, test } from "bun:test";
import { unreadableAppliedStateError } from "@lando/container-runtime/applied-state";
import { AppId, ServiceName } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import { tearDownOrphans } from "../../src/operations/orphan-teardown.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("orphan sweep reports protected A and continues removing B", async () => {
  const a = AppId.make("damaged-a");
  const b = AppId.make("readable-b");
  const removed: string[] = [];
  const provider = {
    ...TestRuntimeProvider,
    removeObservedService: (service: Parameters<typeof TestRuntimeProvider.removeObservedService>[0]) =>
      service.app === a
        ? Effect.fail(
            unreadableAppliedStateError({
              providerId: plan.provider,
              path: `${plan.root}/isolated-state/damaged-a.json`,
              layout: "per-app",
            }),
          )
        : Effect.sync(() => {
            removed.push(service.app);
            return { kind: "removed" as const };
          }),
  };
  const harness = makeHarness({
    selectProvider: () => Effect.succeed(provider),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
  });
  const result = await Effect.runPromise(
    tearDownOrphans({
      root: plan.root,
      groups: [a, b].map((appId) => ({
        providerId: plan.provider,
        appId,
        volumes: [],
        services: [
          {
            providerId: plan.provider,
            app: appId,
            appRoot: plan.root,
            service: ServiceName.make("web"),
            status: "running" as const,
            publications: { status: "unknown" as const },
          },
        ],
      })),
      options: { volumes: true, purgeCaches: true },
    }).pipe(Effect.provide(harness.layer)),
  );
  expect(removed).toEqual([b]);
  expect(result.services).toEqual(["web"]);
  expect(harness.events.filter((event) => event._tag === "message.warn")).toEqual([
    expect.objectContaining({ body: expect.stringContaining(a) }),
  ]);
});
