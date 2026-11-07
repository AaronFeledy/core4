import { describe, expect, test } from "bun:test";
import { type EndpointPlan, PortablePath, type ScanPlan, type ScannerConfig } from "@lando/sdk/schema";
import { attachScanPlans } from "../../src/planner/scanner-plan.ts";
import { plan, web } from "../operations/start-progress-topology-support.ts";

describe("resolveScanPlan", () => {
  const defaults: ScanPlan = { enabled: true, path: "/", okCodes: [], retries: 2, timeoutMs: 20000 };
  const tuned: ScannerConfig = { path: "/ready", okCodes: [200, 302], retries: 5, timeout: 9000 };
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly global: ScannerConfig | undefined;
    readonly service: ScannerConfig | undefined;
    readonly expected: ScanPlan;
  }> = [
    {
      name: "uses defaults when both layers are absent",
      global: undefined,
      service: undefined,
      expected: defaults,
    },
    {
      name: "inherits global tuning when the service is absent",
      global: tuned,
      service: undefined,
      expected: { enabled: true, path: "/ready", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "overrides only named service fields",
      global: tuned,
      service: { path: "/service" },
      expected: { enabled: true, path: "/service", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "disables when global is false",
      global: false,
      service: undefined,
      expected: { ...defaults, enabled: false },
    },
    {
      name: "disables when service is false despite global tuning",
      global: tuned,
      service: false,
      expected: { enabled: false, path: "/ready", okCodes: [200, 302], retries: 5, timeoutMs: 9000 },
    },
    {
      name: "keeps global false terminal despite explicit service tuning",
      global: false,
      service: { path: "/service" },
      expected: { ...defaults, enabled: false, path: "/service" },
    },
    {
      name: "preserves zero retries",
      global: tuned,
      service: { retries: 0 },
      expected: { enabled: true, path: "/ready", okCodes: [200, 302], retries: 0, timeoutMs: 9000 },
    },
  ];
  for (const scenario of cases) {
    test(scenario.name, async () => {
      // Given: a pair of scanner configuration layers.
      const { resolveScanPlan } = await import("../../src/planner/scanner-plan.ts");
      // When
      const result = resolveScanPlan(scenario.global, scenario.service);
      // Then
      expect(result).toEqual(scenario.expected);
    });
  }
});

test("does not add HTTP scan metadata to TCP, UDP or Unix listeners", () => {
  // Given listeners without an HTTP surface.
  const endpoints: readonly EndpointPlan[] = [
    { _tag: "internal", protocol: "tcp", port: 5432 },
    { _tag: "internal", protocol: "udp", port: 5353 },
    { _tag: "internal", protocol: "unix", socketPath: PortablePath.make("/run/listener.sock") },
  ];
  const input = { ...plan, services: { [web.name]: { ...web, endpoints } } };
  // When global HTTP scan tuning is attached.
  const result = attachScanPlans(input, { path: "/global" }, []);
  // Then non-HTTP listener projections remain unchanged.
  expect(result.services[web.name]?.endpoints).toEqual(endpoints);
});

test.each([
  { global: undefined, service: undefined, path: "/minio/health/live", okCodes: [204] },
  { global: { path: "/" }, service: undefined, path: "/", okCodes: [204] },
  { global: { okCodes: [] }, service: undefined, path: "/minio/health/live", okCodes: [] },
  {
    global: { path: "/global", okCodes: [302] },
    service: { path: "/", okCodes: [] },
    path: "/",
    okCodes: [],
  },
] satisfies readonly {
  global: ScannerConfig | undefined;
  service: ScannerConfig | undefined;
  path: string;
  okCodes: readonly number[];
}[])(
  "projects sparse overrides independently onto endpoint defaults: %j",
  ({ global, service, path, okCodes }) => {
    // Given: two listener facets sharing sparse defaults and a separate console.
    const endpoints: readonly EndpointPlan[] = [
      { _tag: "internal", protocol: "http", port: 9000, scan: { path: "/minio/health/live" } },
      { _tag: "published", protocol: "http", port: 9000, publication: {}, scan: { okCodes: [204] } },
      { _tag: "internal", protocol: "http", port: 9001, scan: { path: "/" } },
    ];
    const input = { ...plan, services: { [web.name]: { ...web, endpoints } } };
    // When
    const result = attachScanPlans(input, global, [
      {
        name: web.name,
        resolution: {
          base: "l337",
          features: [],
          normalizedConfig: service === undefined ? {} : { scanner: service },
        },
      },
    ]);
    // Then: both facets carry one resolved logical policy; console stays independent.
    expect(result.services[web.name]?.endpoints.slice(0, 2).map((endpoint) => endpoint.scan)).toEqual([
      { path, okCodes },
      { path, okCodes },
    ]);
    expect(result.services[web.name]?.endpoints[2]?.scan).toEqual({
      path:
        service && service.path !== undefined
          ? service.path
          : global && global.path !== undefined
            ? global.path
            : "/",
      okCodes:
        service && service.okCodes !== undefined
          ? service.okCodes
          : global && global.okCodes !== undefined
            ? global.okCodes
            : [],
    });
  },
);

test.each([
  { global: false, service: { retries: 0 } },
  { global: { path: "/global" }, service: false },
] satisfies readonly { global: ScannerConfig; service: ScannerConfig }[])(
  "endpoint defaults preserve terminal disable policy: %j",
  ({ global, service }) => {
    // Given
    const input = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          endpoints: [
            {
              _tag: "internal",
              protocol: "http",
              port: 9000,
              scan: { path: "/health" },
            } satisfies EndpointPlan,
          ],
        },
      },
    };
    // When
    const result = attachScanPlans(input, global, [
      {
        name: web.name,
        resolution: { base: "l337", features: [], normalizedConfig: { scanner: service } },
      },
    ]);
    // Then
    expect(result.services[web.name]?.scanner?.enabled).toBe(false);
  },
);
