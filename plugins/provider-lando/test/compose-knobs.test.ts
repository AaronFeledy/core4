import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import { ComposeServiceKnobKey, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";

import { podmanComposeKnobsForPlatform, realizePodmanComposeKnobs } from "../src/compose-knobs.ts";
import { EMPTY_REALIZATION, KNOB_FIXTURES, type KnobRealization } from "./compose-knobs-fixtures.ts";

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

// Both bundled providers always speak to Podman over a REMOTE socket, where
// these drivers are categorically rejected — unlike a merely unknown driver
// name, which is an operand Podman itself validates.
const REMOTE_INVALID_LOG_DRIVERS = ["passthrough", "passthrough-tty"] as const;

// =============================================================================
// Tests
// =============================================================================

describe("podman Compose runtime knob declaration", () => {
  for (const platform of ["linux", "darwin", "win32"] as const) {
    test(`Given host platform ${platform}, when knobs are listed, then every knob appears in published order`, () => {
      const supported = podmanComposeKnobsForPlatform(platform);

      expect(supported).toEqual(ComposeServiceKnobKey.literals.filter((key) => key in KNOB_FIXTURES));
      expect(supported).toHaveLength(21);
      for (const knob of EXCLUDED_KNOBS) {
        expect(supported).not.toContain(knob);
      }
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

  test("Given an unsafe integer ulimit, when realized, then onInvalid rejects the rounded bound", () => {
    const calls = captureInvalid({
      ulimits: { nofile: { soft: "9007199254740993", hard: "9007199254740993" } },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.details).toMatchObject({ knob: "ulimits", bound: "soft" });
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

  test("Given duplicate tmpfs destinations, when realized, then onInvalid rejects the lossy mapping", () => {
    const calls = captureInvalid({ tmpfs: ["/tmp:size=64m", "/tmp:mode=1777"] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.details).toMatchObject({ knob: "tmpfs", target: "/tmp" });
  });

  for (const stopGracePeriod of [0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    test(`Given stop_grace_period ${stopGracePeriod}, when realized, then onInvalid rejects it`, () => {
      const calls = captureInvalid({ stop_grace_period: stopGracePeriod });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.details).toMatchObject({ knob: "stop_grace_period", value: stopGracePeriod });
    });
  }

  for (const shmSize of [0, -1]) {
    test(`Given shm_size ${shmSize}, when realized, then onInvalid rejects it`, () => {
      const calls = captureInvalid({ shm_size: shmSize });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.details).toMatchObject({ knob: "shm_size", value: shmSize });
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
