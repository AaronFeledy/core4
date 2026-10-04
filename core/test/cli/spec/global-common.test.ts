import { expect, test } from "bun:test";
import { AbsolutePath, AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  availableGlobalServiceList,
  globalAppRef,
  renderGlobalServiceRow,
  selectGlobalServices,
  unknownGlobalServiceError,
  withGlobalLifecycleEvents,
} from "../../../src/cli/commands/meta/global-common";

test("marks the app global when projecting a plan identity", () => {
  const plan = { id: AppId.make("host"), root: AbsolutePath.make("/tmp/global") };
  const result = globalAppRef(plan);
  expect(result).toEqual({ kind: "global", id: plan.id, root: plan.root });
});

test("brackets successful work in pre/body/post order and preserves its result", async () => {
  const order: string[] = [];
  const result = await Effect.runPromise(
    withGlobalLifecycleEvents(
      {
        pre: () =>
          Effect.sync(() => {
            order.push("pre");
          }),
        post: (value) =>
          Effect.sync(() => {
            order.push(`post:${value}`);
          }),
      },
      Effect.sync(() => {
        order.push("body");
        return 42;
      }),
    ),
  );
  expect(order).toEqual(["pre", "body", "post:42"]);
  expect(result).toBe(42);
});

test("suppresses the post event when the body fails", async () => {
  const order: string[] = [];
  const result = await Effect.runPromise(
    Effect.flip(
      withGlobalLifecycleEvents(
        {
          pre: () =>
            Effect.sync(() => {
              order.push("pre");
            }),
          post: () =>
            Effect.sync(() => {
              order.push("post");
            }),
        },
        Effect.fail("failure"),
      ),
    ),
  );
  expect(order).toEqual(["pre"]);
  expect(result).toBe("failure");
});

const services = {
  proxy: { name: "proxy", dependsOn: [{ service: "mail" }] },
  mail: { name: "mail", dependsOn: [{ service: "missing-optional" }] },
};

test("sorts available names independently of plan order", () => {
  const result = availableGlobalServiceList(services);
  expect(result).toBe("mail, proxy");
});

test.each([
  {
    services: {},
    withRemediation: true,
    message: "meta:global:start: service nope is not in the global app plan.",
    remediation: undefined,
  },
  {
    services,
    withRemediation: true,
    message: "meta:global:start: service nope is not in the global app plan (available: mail, proxy).",
    remediation: "Example: lando global:start --service mail",
  },
  {
    services,
    withRemediation: false,
    message: "meta:global:info: service nope is not in the global app plan (available: mail, proxy).",
    remediation: undefined,
  },
])("preserves the error fields with remediation=$withRemediation", (fixture) => {
  const commandId = fixture.withRemediation ? "meta:global:start" : "meta:global:info";
  const result = unknownGlobalServiceError({
    commandId,
    requested: "nope",
    services: fixture.services,
    withRemediation: fixture.withRemediation,
  });
  expect(result._tag).toBe("ToolingExecError");
  expect(result.tool).toBe(commandId);
  expect(result.message).toBe(fixture.message);
  expect(result.remediation).toBe(fixture.remediation);
  expect(Object.hasOwn(result, "remediation")).toBe(fixture.remediation !== undefined);
});

test.each([
  { expandDependencies: true, requested: ["proxy"], expected: [services.proxy, services.mail] },
  { expandDependencies: false, requested: ["proxy"], expected: [services.proxy] },
  {
    expandDependencies: false,
    requested: ["mail", "proxy", "mail"],
    expected: [services.proxy, services.mail],
  },
  { expandDependencies: false, requested: [], expected: [services.proxy, services.mail] },
  { expandDependencies: true, requested: undefined, expected: [services.proxy, services.mail] },
])(
  "selects in plan order with dependencies=$expandDependencies and requested=$requested",
  async (fixture) => {
    const result = await Effect.runPromise(
      selectGlobalServices({
        commandId: "meta:global:start",
        services,
        requested: fixture.requested,
        expandDependencies: fixture.expandDependencies,
      }),
    );
    expect(result).toEqual(fixture.expected);
  },
);

test("rejects the first unknown requested name before dependency expansion", async () => {
  const result = await Effect.runPromise(
    Effect.flip(
      selectGlobalServices({
        commandId: "meta:global:status",
        services,
        requested: ["nope", "other"],
        expandDependencies: false,
      }),
    ),
  );
  expect(result.message).toBe(
    "meta:global:status: service nope is not in the global app plan (available: mail, proxy).",
  );
  expect(result.remediation).toBe("Example: lando global:status --service mail");
});

test.each([
  { endpoints: [], expected: "web (running) no endpoints" },
  { endpoints: ["https://a", "https://b"], expected: "web (running) https://a, https://b" },
])("renders endpoints when the service has $endpoints", ({ endpoints, expected }) => {
  const service = { name: "web", state: "running", endpoints };
  const result = renderGlobalServiceRow(service);
  expect(result).toBe(expected);
});
