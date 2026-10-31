import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName, appIdentityKey } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { Effect, Layer } from "effect";
import { globalStop } from "../../src/operations/global-stop.ts";
import * as LandoEventService from "../../src/services/event-service.ts";
import { makeGlobalLifecycleFixture } from "../../src/testing/global-lifecycle.ts";

test("selected stop withdraws missing service routes without removing its live sibling", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-stop-missing-"));
  try {
    const fixture = makeGlobalLifecycleFixture(root);
    const base = fixture.planFor(["mail", "sibling"]);
    const plan = {
      ...base,
      identity: { appRoot: base.root, ownerKey: appIdentityKey("owner", base.root) },
    };
    fixture.setApplied(plan);
    fixture.startContainer(plan, "sibling");
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const stopped = yield* globalStop({ services: ["mail"] });
        const events = yield* EventService;
        return { stopped, events: yield* events.query("*-global-stop") };
      }).pipe(Effect.provide(Layer.merge(fixture.layer, LandoEventService.layer))),
    );
    expect(result.stopped).toMatchObject({ outcome: "unchanged", servicesStopped: [] });
    expect(result.events).toEqual([]);
    expect(fixture.removed).toEqual([]);
    expect(fixture.containers.get("sibling")?.containerId).toBe("global-sibling");
    expect(fixture.published).toEqual([["sibling"]]);
    expect(
      await Effect.runPromise(fixture.provider.inspect({ app: plan.id, service: ServiceName.make("mail") })),
    ).toMatchObject({
      status: "stopped",
      state: "stopped",
      publications: { status: "missing" },
      mounts: { status: "missing" },
    });
    expect(await Effect.runPromise(fixture.registry.resolveAppliedPlan(plan.root))).toEqual(plan);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
