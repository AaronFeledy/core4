import { describe, expect, it } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";

import { requireVolume } from "../src/actions.ts";
import { toSqlPlan } from "../src/views.ts";

describe("SQL physical volume selection", () => {
  it.each([undefined, "original"])(
    "selects database storage with dataName=%s when a shared home is first",
    async (dataName) => {
      // Given a resolved service with home storage before the database mount.
      const plan = toSqlPlan({
        id: "app",
        root: "/app",
        identity: { appRoot: "/app", ownerKey: "owner", ...(dataName === undefined ? {} : { dataName }) },
        services: {
          database: {
            name: "database",
            type: "mysql:8.0",
            environment: {},
            mounts: [
              { type: "volume", store: "shared-home", target: "/home/lando", readOnly: false },
              { type: "volume", store: "data", target: "/var/lib/mysql", readOnly: false },
            ],
          },
        },
      });
      const service = plan.services.database;
      if (!service) throw new Error("missing fixture service");
      // When selecting a physical data target.
      const volume = await Effect.runPromise(requireVolume(plan, service, "database"));
      // Then selection retains destination semantics rather than array order.
      expect(volume.store).toBe("data");
      expect(volume.app).toBe(AppId.make(dataName ?? "app"));
    },
  );

  it("rejects storage whose destination is unknown", async () => {
    // Given a volume name without a database mount destination.
    const plan = toSqlPlan({
      id: "app",
      services: {
        database: {
          type: "mysql:8.0",
          mounts: [{ type: "volume", store: "unproven", target: "/somewhere-else", readOnly: false }],
        },
      },
    });
    const service = plan.services.database;
    if (!service) throw new Error("missing fixture service");
    // When selecting the volume, then refuse rather than infer from its position.
    const result = await Effect.runPromise(Effect.result(requireVolume(plan, service, "database")));
    expect(result._tag).toBe("Failure");
  });

  it("rejects duplicate database destinations", async () => {
    // Given two mounts claiming the same destination.
    const plan = toSqlPlan({
      id: "app",
      services: {
        database: {
          type: "mysql:8.0",
          mounts: [
            { type: "volume", store: "a", target: "/var/lib/mysql", readOnly: false },
            { type: "volume", store: "b", target: "/var/lib/mysql", readOnly: false },
          ],
        },
      },
    });
    const service = plan.services.database;
    if (!service) throw new Error("missing fixture service");
    // When selecting the volume, then the ambiguity fails closed.
    const result = await Effect.runPromise(Effect.result(requireVolume(plan, service, "database")));
    expect(result._tag).toBe("Failure");
  });
});
