import { describe, expect, test } from "bun:test";
import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { DateTime } from "effect";

import type { EngineDialect } from "../src/dialect.ts";
import { realizePodmanComposeKnobs } from "../src/podman/compose-knobs.ts";
import {
  EMPTY_REALIZATION,
  KNOB_FIXTURES_BY_DIALECT,
  type KnobRealization,
} from "./compose-knobs-fixtures.ts";

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
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: { resolvedAt: DateTime.makeUnsafe(0), source: "/app/.lando.yml", runtime: 4 },
  extensions: compose === undefined ? {} : { compose },
});

const rejectInvalid = (message: string, details: Record<string, unknown>): never => {
  throw new Error(`unexpected onInvalid: ${message} ${JSON.stringify(details)}`);
};

const realize = (compose: Record<string, unknown>, dialect: EngineDialect = "libpod"): KnobRealization =>
  realizePodmanComposeKnobs(serviceWithCompose(compose), { onInvalid: rejectInvalid, dialect });

const captureInvalid = (
  compose: Record<string, unknown>,
  dialect: EngineDialect = "libpod",
): ReadonlyArray<InvalidCall> => {
  const calls: InvalidCall[] = [];
  const onInvalid = (message: string, details: Record<string, unknown>): never => {
    calls.push({ message, details });
    throw new Error(message);
  };

  expect(() => realizePodmanComposeKnobs(serviceWithCompose(compose), { onInvalid, dialect })).toThrow();
  return calls;
};

/** Issue paths the untyped-extensions guard reports, e.g. "deploy.resources.limits.cpus". */
const invalidPaths = (call: InvalidCall | undefined): ReadonlyArray<string> => {
  const issues = call?.details.issues;
  return Array.isArray(issues)
    ? issues.map((issue: { readonly path?: ReadonlyArray<PropertyKey> }) => (issue.path ?? []).join("."))
    : [];
};

const BOOLEAN_KNOBS = [
  ["privileged", "Privileged"],
  ["read_only", "ReadonlyRootfs"],
] as const;

const TRUTHY_SPELLINGS = ["true", "1", "yes", "on", "YES", "On"];
const FALSY_SPELLINGS = ["false", "0", "no", "off", "NO", "Off"];

// Both bundled providers always speak to Podman over a REMOTE socket, where
// these drivers are categorically rejected — unlike a merely unknown driver
// name, which is an operand Podman itself validates.
const REMOTE_INVALID_LOG_DRIVERS = ["passthrough", "passthrough-tty"] as const;

describe("podman Compose runtime knob realization", () => {
  for (const dialect of ["libpod", "docker"] as const) {
    for (const [knob, fixture] of Object.entries(KNOB_FIXTURES_BY_DIALECT[dialect])) {
      test(`Given a service using the ${knob} knob, when realized for ${dialect}, then it lands in its documented slot`, () => {
        expect(realize(fixture.input, dialect)).toEqual(fixture.expected);
      });
    }
  }

  test("Given a service without Compose extensions, when realized, then every fragment is empty", () => {
    expect(realizePodmanComposeKnobs(serviceWithCompose(), { onInvalid: rejectInvalid })).toEqual(
      EMPTY_REALIZATION,
    );
  });

  test("Given an empty Compose extension bag, when realized, then every fragment is empty", () => {
    expect(realize({})).toEqual(EMPTY_REALIZATION);
  });

  test("Given only knobs libpod does not realize, when realized for libpod, then nothing is emitted and nothing fails", () => {
    expect(
      realize({
        gpus: "all",
        deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } },
        labels: { "dev.lando.app": "myapp" },
        tmpfs: ["/run"],
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

  test("Given an unsafe integer ulimit, when realized, then onInvalid rejects the rounded bound", () => {
    const calls = captureInvalid({
      ulimits: { nofile: { soft: "9007199254740993", hard: "9007199254740993" } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.details).toMatchObject({ knobs: ["ulimits"] });
    expect(invalidPaths(calls[0])).toContain("ulimits.nofile.soft");
  });

  test("Given null, numeric, and boolean sysctls, when realized, then each is stringified", () => {
    expect(
      realize({ sysctls: { "net.ipv4.ip_forward": 1, "kernel.shm": null, "net.debug": true } }).hostConfig,
    ).toEqual({
      Sysctls: { "net.ipv4.ip_forward": "1", "kernel.shm": "", "net.debug": "true" },
    });
  });

  for (const dialect of ["libpod", "docker"] as const) {
    for (const [stopGracePeriod, timeout] of [
      [0.4, 0],
      [0, 0],
      [-0, 0],
      [2.9, 2],
    ] as const) {
      test(`Given stop_grace_period ${stopGracePeriod}, when realized for ${dialect}, then StopTimeout is ${timeout} whole seconds`, () => {
        const { topLevel } = realize({ stop_grace_period: stopGracePeriod }, dialect);

        expect(topLevel).toEqual({ StopTimeout: timeout });
        expect(Object.is(topLevel.StopTimeout, -0)).toBe(false);
      });
    }
  }

  for (const stopGracePeriod of [-0.5, -1, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    test(`Given stop_grace_period ${stopGracePeriod}, when realized, then onInvalid rejects it`, () => {
      const calls = captureInvalid({ stop_grace_period: stopGracePeriod });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.details).toMatchObject({ knobs: ["stop_grace_period"] });
    });
  }

  for (const shmSize of [0, -1]) {
    test(`Given shm_size ${shmSize}, when realized, then onInvalid rejects it`, () => {
      const calls = captureInvalid({ shm_size: shmSize });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.details).toMatchObject({ knobs: ["shm_size"] });
    });
  }

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

  for (const driver of REMOTE_INVALID_LOG_DRIVERS) {
    test(`Given the remote-invalid ${driver} log driver, when realized, then onInvalid names the driver`, () => {
      const calls = captureInvalid({ logging: { driver } });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.message).toContain(driver);
      expect(calls[0]?.details).toMatchObject({ knob: "logging", driver });
    });
  }

  for (const driver of ["k8s-file", "json-file", "journald", "none"]) {
    test(`Given the remote-compatible ${driver} log driver, when realized, then it is passed through`, () => {
      expect(realize({ logging: { driver } }).hostConfig).toEqual({ LogConfig: { Type: driver } });
    });
  }

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

describe("Compose deploy.resources and GPU realization", () => {
  test.each([
    ["number", 1.5, 1_500_000_000],
    ["decimal string", "0.25", 250_000_000],
    ["integer string", "2", 2_000_000_000],
    ["leading-dot string", ".5", 500_000_000],
  ])(
    "Given limits.cpus as a %s, when realized, then NanoCpus is the rounded nanosecond share",
    (_, cpus, nano) => {
      expect(realize({ deploy: { resources: { limits: { cpus } } } }).hostConfig).toEqual({ NanoCpus: nano });
    },
  );

  test("Given zero limits and pids of -1, when realized, then no limit is applied", () => {
    expect(
      realize({
        deploy: { resources: { limits: { cpus: 0, memory: 0, pids: -1 }, reservations: { memory: 0 } } },
      }),
    ).toEqual(EMPTY_REALIZATION);
  });

  test("Given pids as an integer string, when realized, then PidsLimit is an integer", () => {
    expect(realize({ deploy: { resources: { limits: { pids: "64" } } } }).hostConfig).toEqual({
      PidsLimit: 64,
    });
  });

  test.each([
    ["limits.cpus", { limits: { cpus: "half" } }],
    ["limits.cpus", { limits: { cpus: -1 } }],
    ["limits.cpus", { limits: { cpus: 1e308 } }],
    ["limits.cpus", { limits: { cpus: "10000000" } }],
    ["limits.pids", { limits: { pids: "9007199254740993" } }],
    ["limits.memory", { limits: { memory: -1 } }],
    ["limits.pids", { limits: { pids: "many" } }],
    ["reservations.memory", { reservations: { memory: -1 } }],
  ])("Given an invalid %s, when realized, then onInvalid names the field", (field, resources) => {
    const calls = captureInvalid({ deploy: { resources } });

    expect(calls).toHaveLength(1);
    expect(invalidPaths(calls[0])).toContain(`deploy.resources.${field}`);
  });

  test("Given gpus all, when realized for docker, then one request asks for every GPU", () => {
    expect(realize({ gpus: "all" }, "docker").hostConfig).toEqual({
      DeviceRequests: [{ Count: -1, Capabilities: [["gpu"]] }],
    });
  });

  test("Given gpus and reserved devices together, when realized for docker, then both requests are kept in order", () => {
    expect(
      realize(
        {
          gpus: [{ count: "all" }],
          deploy: {
            resources: {
              reservations: {
                devices: [{ driver: "cdi", device_ids: ["vendor.com/dev=0"], capabilities: [] }],
              },
            },
          },
        },
        "docker",
      ).hostConfig,
    ).toEqual({
      DeviceRequests: [
        { Count: -1, Capabilities: [["gpu"]] },
        { Driver: "cdi", Count: 0, DeviceIDs: ["vendor.com/dev=0"], Capabilities: [[]] },
      ],
    });
  });

  test("Given a device request without count or ids, when realized for docker, then it asks for every device", () => {
    expect(
      realize({ deploy: { resources: { reservations: { devices: [{ capabilities: ["gpu"] }] } } } }, "docker")
        .hostConfig,
    ).toEqual({ DeviceRequests: [{ Count: -1, Capabilities: [["gpu"]] }] });
  });

  test("Given a non-numeric device count, when realized for docker, then onInvalid names the knob", () => {
    const calls = captureInvalid({ gpus: [{ count: "some" }] }, "docker");

    expect(calls).toHaveLength(1);
    expect(invalidPaths(calls[0])).toContain("gpus.0.count");
  });
});
