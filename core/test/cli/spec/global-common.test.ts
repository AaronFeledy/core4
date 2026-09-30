import { expect, test } from "bun:test";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { globalAppRef, renderGlobalServiceRow } from "../../../src/cli/commands/meta/global-common";

test("marks the app global when projecting a plan identity", () => {
  const plan = { id: AppId.make("host"), root: AbsolutePath.make("/tmp/global") };
  const result = globalAppRef(plan);
  expect(result).toEqual({ kind: "global", id: plan.id, root: plan.root });
});

test.each([
  { endpoints: [], expected: "web (running) no endpoints" },
  { endpoints: ["https://a", "https://b"], expected: "web (running) https://a, https://b" },
])("renders endpoints when the service has $endpoints", ({ endpoints, expected }) => {
  const service = { name: "web", state: "running", endpoints };
  const result = renderGlobalServiceRow(service);
  expect(result).toBe(expected);
});
