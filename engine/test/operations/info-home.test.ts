import { expect, test } from "bun:test";
import { type ServiceHomePlan, ServiceInfo } from "@lando/sdk/schema";
import { Schema } from "effect";
import { runInfo, service } from "./info-storage-fixture.ts";

const homes = [
  { state: "persisted", target: "/root", store: "old-home", user: "root" },
  { state: "authored", target: "/root", mount: "bind" },
  { state: "disabled" },
  { state: "unknown", reason: "custom-image" },
  { state: "unknown", reason: "no-identity" },
  { state: "unknown", reason: "undeclared-user", user: "someone" },
] as const satisfies readonly ServiceHomePlan[];

test.each([...homes])("projects home unchanged without extra provider calls: %j", async (home) => {
  // Given a plan carrying each home state.
  const selected = { ...service, home };
  // When projecting info.
  const { row, calls } = await runInfo(selected);
  // Then preserve the contract and the existing observation budget.
  expect(row?.home).toEqual(home);
  if (row === undefined) throw new Error("Expected a service info row");
  expect(JSON.parse(JSON.stringify(Schema.encodeSync(ServiceInfo)(row))).home).toEqual(home);
  expect(calls).toEqual(["select", "inspect:web"]);
});

test("omits home when an older plan has no home field", async () => {
  // Given an older plan, when projecting it.
  const { row } = await runInfo(service);
  // Then no home fact is invented.
  expect(row).not.toHaveProperty("home");
});

test("keeps home after status so scripts matching a service's leading fields keep working", async () => {
  // Given a service whose home is a nested object.
  const { row } = await runInfo({ ...service, home: homes[0] });
  if (row === undefined) throw new Error("Expected a service info row");
  // When the row is encoded to its JSON wire form.
  const json = JSON.stringify(Schema.encodeSync(ServiceInfo)(row));
  // Then no object closes between the service name and its status.
  expect(json).toMatch(/"service":"web"[^}]*"status":"/u);
  expect(json.indexOf('"status"')).toBeLessThan(json.indexOf('"home"'));
});
