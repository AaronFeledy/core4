import { describe, expect, it } from "bun:test";
import { Effect } from "effect";

import { requireVolume } from "../src/actions.ts";
import { toSqlPlan } from "../src/views.ts";

describe("SQL physical volume selection", () => {
  it("selects database storage when a shared home is first", async () => {
    // Given a resolved service with home storage before the database mount.
    const plan = toSqlPlan({
      id: "app",
      root: "/app",
      services: {
        database: {
          name: "database",
          type: "mysql:8.0",
          environment: {},
          storage: [
            { store: "shared-home", target: "/home/lando" },
            { store: "data", target: "/var/lib/mysql" },
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
  });

  it("rejects storage whose destination is unknown", async () => {
    // Given a volume name without a database mount destination.
    const plan = toSqlPlan({
      id: "app",
      services: {
        database: {
          type: "mysql:8.0",
          storage: [{ store: "unproven" }],
        },
      },
    });
    const service = plan.services.database;
    if (!service) throw new Error("missing fixture service");
    // When selecting the volume, then refuse rather than infer from its position.
    const result = await Effect.runPromise(Effect.either(requireVolume(plan, service, "database")));
    expect(result._tag).toBe("Left");
  });

  it("rejects duplicate database destinations", async () => {
    // Given two mounts claiming the same destination.
    const plan = toSqlPlan({
      id: "app",
      services: {
        database: {
          type: "mysql:8.0",
          storage: [
            { store: "a", target: "/var/lib/mysql" },
            { store: "b", target: "/var/lib/mysql" },
          ],
        },
      },
    });
    const service = plan.services.database;
    if (!service) throw new Error("missing fixture service");
    // When selecting the volume, then the ambiguity fails closed.
    const result = await Effect.runPromise(Effect.either(requireVolume(plan, service, "database")));
    expect(result._tag).toBe("Left");
  });
});
