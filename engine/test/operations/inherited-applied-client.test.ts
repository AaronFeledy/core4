import { expect, test } from "bun:test";
import { CurrentExecutableAppPlan } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { planInherited } from "../planner/inherited-service-fixture.ts";
import { appliedClientFixture } from "./applied-client-fixture.ts";

test("real inherited PostgreSQL client invokes with applied drift without resolving absent desired reference", async () => {
  const inherited = await Effect.runPromise(
    planInherited("postgres", {
      creds: { user: "desired", database: "desired", password: "${secret:MISSING}" },
      port: 6543,
    }),
  );
  const persisted = Schema.decodeUnknownSync(CurrentExecutableAppPlan)(
    JSON.parse(JSON.stringify(Schema.encodeSync(CurrentExecutableAppPlan)(inherited.plan))),
    { onExcessProperty: "error" },
  );
  const fixture = appliedClientFixture({
    inherited: { ...inherited, plan: persisted },
    missingDesired: true,
  });
  fixture.secretEnv.LANDO_SECRET_APPLIED = "fresh-applied-value";
  const result = await fixture.run();
  expect(result._tag).toBe("Success");
  expect(fixture.calls[0]).toMatchObject({
    command: ["psql", "-p", "5433", "-U", "APPLIED-user", "-d", "APPLIED-db"],
    env: { PGPASSWORD: "fresh-applied-value" },
  });
});
