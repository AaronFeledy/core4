import { expect, test } from "bun:test";
import { AbsolutePath, AppId, type ServiceConnection, type StartedService } from "@lando/sdk/schema";
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
    remediation: "Add service nope to the Landofile, or pick an existing service name.",
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
    remediation: "Use one of the available services (mail, proxy).",
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
  expect(result.remediation.trim().length).toBeGreaterThan(0);
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
  { endpoints: [], internal: [], expected: "web (running) no endpoints" },
  {
    endpoints: ["https://a", "https://b"],
    internal: [],
    expected: "web (running) Host: https://a, https://b",
  },
  { endpoints: [], internal: ["tcp://web:1025"], expected: "web (running) App Network: tcp://web:1025" },
  {
    endpoints: ["https://a"],
    internal: ["http://web:8025"],
    expected: "web (running) Host: https://a App Network: http://web:8025",
  },
])("renders host $endpoints and app-network $internal addresses", ({ endpoints, internal, expected }) => {
  const connection = (url: string, scope: "host" | "app"): ServiceConnection => ({
    ...(scope === "host"
      ? ({ scope: "host", source: "publication" } as const)
      : ({ scope: "app", source: "listener" } as const)),
    binding: "assigned",
    state: "active",
    url,
    protocol: "http",
    host: "web",
    port: 80,
    alternateUrls: [],
    endpoint: { port: 80, transport: "tcp", names: [], primary: false },
  });
  const service: StartedService = {
    name: "web",
    state: "running",
    connections: [
      ...endpoints.map((url) => connection(url, "host")),
      ...internal.map((url) => connection(url, "app")),
    ],
  };
  const result = renderGlobalServiceRow(service);
  expect(result).toBe(expected);
});
