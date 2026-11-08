import { expect, test } from "bun:test";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { infoForPlan } from "../../src/operations/info.ts";
import { identityPlan, identityRegistry } from "./data-identity-support.ts";

test.each([
  { dataName: "original", expected: "original" },
  { dataName: "current", expected: undefined },
  { dataName: undefined, expected: undefined },
])("info reports the retained data name only when it differs: $dataName", async ({ dataName, expected }) => {
  const plan = { ...identityPlan("current", dataName), services: {} };
  const result = await Effect.runPromise(
    infoForPlan(plan).pipe(Effect.provideService(RuntimeProviderRegistry, identityRegistry([plan]))),
  );
  expect(result.app).toBe("current");
  expect(result.dataName).toBe(expected);
  expect(Object.hasOwn(result, "dataName")).toBe(expected !== undefined);
});
