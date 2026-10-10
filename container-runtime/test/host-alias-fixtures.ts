import type { ServicePlan } from "@lando/sdk/schema";

interface HostAliasFixture {
  readonly name: string;
  readonly planned: ServicePlan["hostAliases"];
  readonly authored: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly api: ReadonlyArray<string>;
  readonly compose: Readonly<Record<string, string | ReadonlyArray<string>>>;
}

export const HOST_ALIAS_FIXTURES: ReadonlyArray<HostAliasFixture> = [
  { name: "empty", planned: [], authored: {}, api: [], compose: {} },
  {
    name: "empty address lists",
    planned: [],
    authored: { "empty.internal": [] },
    api: [],
    compose: {},
  },
  {
    name: "planned only",
    planned: [{ hostname: "host.lando.internal", ip: "host-gateway" }],
    authored: {},
    api: ["host.lando.internal:host-gateway"],
    compose: { "host.lando.internal": "host-gateway" },
  },
  {
    name: "authored only with repeated IPv4 and IPv6",
    planned: [],
    authored: {
      "api.local": ["192.0.2.10", "192.0.2.11", "2001:db8::1", "2001:db8::2"],
      "host.docker.internal": "192.0.2.20",
      "host.containers.internal": "192.0.2.21",
    },
    api: [
      "api.local:192.0.2.10",
      "api.local:192.0.2.11",
      "api.local:2001:db8::1",
      "api.local:2001:db8::2",
      "host.docker.internal:192.0.2.20",
      "host.containers.internal:192.0.2.21",
    ],
    compose: {
      "api.local": ["192.0.2.10", "192.0.2.11", "2001:db8::1", "2001:db8::2"],
      "host.docker.internal": "192.0.2.20",
      "host.containers.internal": "192.0.2.21",
    },
  },
  {
    name: "merged with case-insensitive planned precedence",
    planned: [{ hostname: "host.lando.internal", ip: "host-gateway" }],
    authored: {
      "host.lando.internal": ["192.0.2.99", "2001:db8::99"],
      "HOST.LANDO.INTERNAL": "192.0.2.98",
      "custom.internal": ["192.0.2.10", "2001:db8::10"],
    },
    api: ["host.lando.internal:host-gateway", "custom.internal:192.0.2.10", "custom.internal:2001:db8::10"],
    compose: { "host.lando.internal": "host-gateway", "custom.internal": ["192.0.2.10", "2001:db8::10"] },
  },
  {
    name: "repeated planned addresses with an authored conflict",
    planned: [
      { hostname: "api.local", ip: "192.0.2.10" },
      { hostname: "api.local", ip: "192.0.2.11" },
      { hostname: "api.local", ip: "2001:db8::1" },
      { hostname: "api.local", ip: "2001:db8::2" },
    ],
    authored: { "API.LOCAL": ["192.0.2.99", "2001:db8::99"] },
    api: ["api.local:192.0.2.10", "api.local:192.0.2.11", "api.local:2001:db8::1", "api.local:2001:db8::2"],
    compose: { "api.local": ["192.0.2.10", "192.0.2.11", "2001:db8::1", "2001:db8::2"] },
  },
  {
    name: "quoted mapping keys and multi-address values",
    planned: [{ hostname: "true", ip: "::1" }],
    authored: { 'alias: with #quotes"': ["192.0.2.10", "2001:db8::1"] },
    api: ["true:::1", 'alias: with #quotes":192.0.2.10', 'alias: with #quotes":2001:db8::1'],
    compose: { true: "::1", 'alias: with #quotes"': ["192.0.2.10", "2001:db8::1"] },
  },
];
