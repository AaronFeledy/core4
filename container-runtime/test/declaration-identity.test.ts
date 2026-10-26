import { expect, test } from "bun:test";
import { AppPlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { makeAppliedPlanCache } from "../src/applied-plan-cache.ts";
import { commonContainerLabels } from "../src/plan.ts";
import { bringUpRecreateReasons } from "../src/podman/bring-up-recreate.ts";
import { plan, service } from "./fixtures/environment-values.ts";

test.each([undefined, "derived-web"])(
  "partial apply persists actual declaration records without backfilling historical identity %j",
  async (previousId) => {
    // Given
    const previous = {
      ...plan,
      services: { web: { ...service, ...(previousId === undefined ? {} : { serviceTypeId: previousId }) } },
    };
    const database = { ...service, name: ServiceName.make("database"), serviceTypeId: "derived-database" };
    const incoming = { ...plan, services: { database } };
    const written: AppPlan[] = [];
    const cache = makeAppliedPlanCache({
      providerId: plan.provider,
      providerName: "test",
      appliedPlanState: { open: () => Effect.die("unused"), withLock: (_key, body) => body },
      load: () => Effect.succeed(previous),
      persist: (_state, applied) =>
        Effect.sync(() => {
          written.push(
            Schema.decodeUnknownSync(AppPlan)(
              JSON.parse(JSON.stringify(Schema.encodeSync(AppPlan)(applied))),
              { onExcessProperty: "error" },
            ),
          );
        }),
      remove: () => Effect.void,
    });
    // When
    await Effect.runPromise(cache.rememberPlan(incoming, false));
    // Then
    expect(written[0]?.services[database.name]?.serviceTypeId).toBe("derived-database");
    expect(written[0]?.services[service.name]?.serviceTypeId).toBe(previousId);
    expect(written[0]?.valueModel).toBe(1);
  },
);

test.each([undefined, "previous-declaration"])(
  "declaration-only change from %j does not request physical recreation",
  (previousId) => {
    // Given
    const previous = { ...service, ...(previousId === undefined ? {} : { serviceTypeId: previousId }) };
    const desired = { ...service, serviceTypeId: "derived-web" };
    const desiredPlan = { ...plan, services: { web: desired } };
    const snapshot = { labels: commonContainerLabels(plan, previous) };
    // When
    const reasons = bringUpRecreateReasons(desiredPlan, desired, snapshot, { skipAbsentFields: true });
    // Then
    expect(reasons).toEqual([]);
  },
);
