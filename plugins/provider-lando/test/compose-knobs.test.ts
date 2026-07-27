import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { ComposeServiceKnobKey, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import {
  PODMAN_COMPOSE_KNOB_REGISTRY,
  podmanComposeKnobsForPlatform,
  realizePodmanComposeKnobs,
} from "../src/compose-knobs.ts";

// =============================================================================
// Hand-written expectation table for the Podman Compose runtime-knob mapping.
//
// Written independently of `compose-knobs.ts` internals — the inputs are the
// canonical (post-decode) knob values core preserves into
// `ServicePlan.extensions.compose`, and the outputs are the Podman
// docker-compatible `POST /containers/create` slots each knob must land in.
// A sibling declaration-vs-mapping diff test imports this table, so keep the
// export name and shape stable.
// =============================================================================

interface KnobRealization {
  readonly hostConfig: Record<string, unknown>;
  readonly topLevel: Record<string, unknown>;
  readonly query: Record<string, string>;
}

interface KnobFixture {
  readonly input: Record<string, unknown>;
  readonly expected: KnobRealization;
}

const inHostConfig = (fragment: Record<string, unknown>): KnobRealization => ({
  hostConfig: fragment,
  topLevel: {},
  query: {},
});

const inTopLevel = (fragment: Record<string, unknown>): KnobRealization => ({
  hostConfig: {},
  topLevel: fragment,
  query: {},
});

const inQuery = (fragment: Record<string, string>): KnobRealization => ({
  hostConfig: {},
  topLevel: {},
  query: fragment,
});

const EMPTY_REALIZATION: KnobRealization = { hostConfig: {}, topLevel: {}, query: {} };

// biome-ignore lint/suspicious/noExportsInTest: the sibling declaration-vs-mapping diff test imports this table.
export const KNOB_FIXTURES = {
  restart: {
    input: { restart: "unless-stopped" },
    expected: inHostConfig({ RestartPolicy: { Name: "unless-stopped" } }),
  },
  cap_add: {
    input: { cap_add: ["NET_ADMIN", "SYS_PTRACE"] },
    expected: inHostConfig({ CapAdd: ["NET_ADMIN", "SYS_PTRACE"] }),
  },
  cap_drop: {
    input: { cap_drop: ["MKNOD"] },
    expected: inHostConfig({ CapDrop: ["MKNOD"] }),
  },
  privileged: {
    input: { privileged: true },
    expected: inHostConfig({ Privileged: true }),
  },
  devices: {
    input: { devices: [{ source: "/dev/sda", target: "/dev/xvda", permissions: "rwm" }] },
    expected: inHostConfig({
      Devices: [{ PathOnHost: "/dev/sda", PathInContainer: "/dev/xvda", CgroupPermissions: "rwm" }],
    }),
  },
  ulimits: {
    input: { ulimits: { nofile: { soft: 20000, hard: 40000 } } },
    expected: inHostConfig({ Ulimits: [{ Name: "nofile", Soft: 20000, Hard: 40000 }] }),
  },
  sysctls: {
    input: { sysctls: { "net.core.somaxconn": 1024 } },
    expected: inHostConfig({ Sysctls: { "net.core.somaxconn": "1024" } }),
  },
  tmpfs: {
    input: { tmpfs: ["/run", "/tmp:size=64m"] },
    expected: inHostConfig({ Tmpfs: { "/run": "", "/tmp": "size=64m" } }),
  },
  shm_size: {
    input: { shm_size: 67108864 },
    expected: inHostConfig({ ShmSize: 67108864 }),
  },
  dns: {
    input: { dns: ["8.8.8.8", "1.1.1.1"] },
    expected: inHostConfig({ Dns: ["8.8.8.8", "1.1.1.1"] }),
  },
  dns_search: {
    input: { dns_search: ["example.com"] },
    expected: inHostConfig({ DnsSearch: ["example.com"] }),
  },
  dns_opt: {
    input: { dns_opt: ["ndots:2"] },
    expected: inHostConfig({ DnsOptions: ["ndots:2"] }),
  },
  extra_hosts: {
    input: { extra_hosts: { "host.local": "10.0.0.1" } },
    expected: inHostConfig({ ExtraHosts: ["host.local:10.0.0.1"] }),
  },
  init: {
    input: { init: true },
    expected: inHostConfig({ Init: true }),
  },
  stop_signal: {
    input: { stop_signal: "SIGUSR1" },
    expected: inTopLevel({ StopSignal: "SIGUSR1" }),
  },
  stop_grace_period: {
    input: { stop_grace_period: 30 },
    expected: inTopLevel({ StopTimeout: 30 }),
  },
  security_opt: {
    input: { security_opt: ["label=disable"] },
    expected: inHostConfig({ SecurityOpt: ["label=disable"] }),
  },
  group_add: {
    input: { group_add: ["audio", 1001] },
    expected: inHostConfig({ GroupAdd: ["audio", "1001"] }),
  },
  read_only: {
    input: { read_only: true },
    expected: inHostConfig({ ReadonlyRootfs: true }),
  },
  platform: {
    input: { platform: "linux/amd64" },
    expected: inQuery({ platform: "linux/amd64" }),
  },
  logging: {
    input: { logging: { driver: "json-file", options: { "max-size": "10m" } } },
    expected: inHostConfig({ LogConfig: { Type: "json-file", Config: { "max-size": "10m" } } }),
  },
} satisfies Record<string, KnobFixture>;

// =============================================================================
// Fixtures
// =============================================================================

interface InvalidCall {
  readonly message: string;
  readonly details: Record<string, unknown>;
}

const serviceWithCompose = (compose?: Record<string, unknown>): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "web",
  provider: ProviderId.make("lando"),
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: DateTime.unsafeMake(0), source: "/app/.lando.yml", runtime: 4 },
  extensions: compose === undefined ? {} : { compose },
});

const rejectInvalid = (message: string, details: Record<string, unknown>): never => {
  throw new Error(`unexpected onInvalid: ${message} ${JSON.stringify(details)}`);
};

const realize = (compose: Record<string, unknown>): KnobRealization =>
  realizePodmanComposeKnobs(serviceWithCompose(compose), { onInvalid: rejectInvalid });

const captureInvalid = (compose: Record<string, unknown>): ReadonlyArray<InvalidCall> => {
  const calls: InvalidCall[] = [];
  const onInvalid = (message: string, details: Record<string, unknown>): never => {
    calls.push({ message, details });
    throw new Error(message);
  };

  expect(() => realizePodmanComposeKnobs(serviceWithCompose(compose), { onInvalid })).toThrow();
  return calls;
};

const BOOLEAN_KNOBS = [
  ["privileged", "Privileged"],
  ["init", "Init"],
  ["read_only", "ReadonlyRootfs"],
] as const;

const TRUTHY_SPELLINGS = ["true", "1", "yes", "on", "YES", "On"];
const FALSY_SPELLINGS = ["false", "0", "no", "off", "NO", "Off"];

const EXCLUDED_KNOBS = ["pull_policy", "gpus", "deploy.resources"] as const;

// =============================================================================
// Tests
// =============================================================================

describe("podman Compose runtime knob registry", () => {
  test("Given the registry, when its keys are listed, then it declares exactly the mapped knobs", () => {
    expect(Object.keys(PODMAN_COMPOSE_KNOB_REGISTRY).sort()).toEqual(Object.keys(KNOB_FIXTURES).sort());
  });

  test("Given the registry, when the unrealizable knobs are looked up, then none is declared", () => {
    for (const knob of EXCLUDED_KNOBS) {
      expect(Object.hasOwn(PODMAN_COMPOSE_KNOB_REGISTRY, knob)).toBe(false);
    }
  });

  for (const platform of ["linux", "darwin", "win32"] as const) {
    test(`Given host platform ${platform}, when knobs are listed, then every knob appears in published order`, () => {
      const supported = podmanComposeKnobsForPlatform(platform);

      expect(supported).toEqual(ComposeServiceKnobKey.literals.filter((key) => key in KNOB_FIXTURES));
      expect(supported).toHaveLength(21);
    });
  }
});

describe("podman Compose runtime knob realization", () => {
  for (const [knob, fixture] of Object.entries(KNOB_FIXTURES)) {
    test(`Given a service using the ${knob} knob, when realized, then it lands in its documented slot`, () => {
      expect(realize(fixture.input)).toEqual(fixture.expected);
    });
  }

  test("Given a service without Compose extensions, when realized, then every fragment is empty", () => {
    expect(realizePodmanComposeKnobs(serviceWithCompose(), { onInvalid: rejectInvalid })).toEqual(
      EMPTY_REALIZATION,
    );
  });

  test("Given an empty Compose extension bag, when realized, then every fragment is empty", () => {
    expect(realize({})).toEqual(EMPTY_REALIZATION);
  });

  test("Given only unrealizable knobs, when realized, then nothing is emitted and nothing fails", () => {
    expect(
      realize({
        pull_policy: "always",
        gpus: "all",
        deploy: { resources: { limits: { cpus: "0.5" } } },
        labels: { "dev.lando.app": "myapp" },
      }),
    ).toEqual(EMPTY_REALIZATION);
  });

  test("Given several knobs at once, when realized, then each fragment collects its own targets", () => {
    expect(realize({ cap_add: ["NET_ADMIN"], stop_signal: "SIGQUIT", platform: "linux/arm64" })).toEqual({
      hostConfig: { CapAdd: ["NET_ADMIN"] },
      topLevel: { StopSignal: "SIGQUIT" },
      query: { platform: "linux/arm64" },
    });
  });
});

describe("podman Compose runtime knob value coercion", () => {
  test("Given a device without target or permissions, when realized, then both default", () => {
    expect(realize({ devices: [{ source: "/dev/fuse" }] }).hostConfig).toEqual({
      Devices: [{ PathOnHost: "/dev/fuse", PathInContainer: "/dev/fuse", CgroupPermissions: "rwm" }],
    });
  });

  test("Given string and negative ulimits, when realized, then both bounds are integers", () => {
    expect(realize({ ulimits: { nofile: { soft: "1024", hard: -1 } } }).hostConfig).toEqual({
      Ulimits: [{ Name: "nofile", Soft: 1024, Hard: -1 }],
    });
  });

  test("Given a non-numeric ulimit, when realized, then onInvalid names the ulimits knob", () => {
    const calls = captureInvalid({ ulimits: { nofile: { soft: "abc", hard: -1 } } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("ulimits");
  });

  test("Given null, numeric, and boolean sysctls, when realized, then each is stringified", () => {
    expect(
      realize({ sysctls: { "net.ipv4.ip_forward": 1, "kernel.shm": null, "net.debug": true } }).hostConfig,
    ).toEqual({
      Sysctls: { "net.ipv4.ip_forward": "1", "kernel.shm": "", "net.debug": "true" },
    });
  });

  test("Given tmpfs mounts with and without options, when realized, then options split on the first colon", () => {
    expect(realize({ tmpfs: ["/run", "/tmp:size=64m,mode=1777"] }).hostConfig).toEqual({
      Tmpfs: { "/run": "", "/tmp": "size=64m,mode=1777" },
    });
  });

  test("Given an extra host with several addresses, when realized, then each becomes its own entry", () => {
    expect(realize({ extra_hosts: { "api.local": ["10.0.0.1", "10.0.0.2"] } }).hostConfig).toEqual({
      ExtraHosts: ["api.local:10.0.0.1", "api.local:10.0.0.2"],
    });
  });

  test("Given a numeric logging option, when realized, then the option value is stringified", () => {
    expect(realize({ logging: { driver: "json-file", options: { "max-file": 3 } } }).hostConfig).toEqual({
      LogConfig: { Type: "json-file", Config: { "max-file": "3" } },
    });
  });

  test("Given logging without a driver, when realized, then LogConfig omits Type", () => {
    expect(realize({ logging: { options: { "max-size": "10m" } } }).hostConfig).toEqual({
      LogConfig: { Config: { "max-size": "10m" } },
    });
  });

  test("Given logging without options, when realized, then LogConfig omits Config", () => {
    expect(realize({ logging: { driver: "journald" } }).hostConfig).toEqual({
      LogConfig: { Type: "journald" },
    });
  });

  for (const [knob, field] of BOOLEAN_KNOBS) {
    test(`Given ${knob} written with YAML truthiness spellings, when realized, then ${field} is a boolean`, () => {
      for (const value of TRUTHY_SPELLINGS) {
        expect(realize({ [knob]: value }).hostConfig).toEqual({ [field]: true });
      }
      for (const value of FALSY_SPELLINGS) {
        expect(realize({ [knob]: value }).hostConfig).toEqual({ [field]: false });
      }
    });

    test(`Given ${knob} set to an unparseable string, when realized, then onInvalid names the knob`, () => {
      const calls = captureInvalid({ [knob]: "maybe" });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.message).toContain(knob);
    });
  }

  test("Given a structurally invalid knob value, when realized, then onInvalid names the knob", () => {
    const calls = captureInvalid({ cap_add: 42 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toContain("cap_add");
  });
});
