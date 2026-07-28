import { expect } from "bun:test";
import { resolve } from "node:path";

import { PortablePath, ServiceName, type ServicePlan } from "@lando/core/schema";

import {
  ComposeFixtureOutcomeError,
  type OutcomeContext,
  valueAt,
} from "./compose-fixture-outcome-values.ts";

type RawFixtureExpectation = (context: OutcomeContext) => void;

export const REQUIRED_RAW_FIXTURE_PATHS = [
  "corpus/depends-on-conditions.compose.yaml",
  "corpus/environment-files-labels.compose.yaml",
  "corpus/healthcheck.compose.yaml",
  "corpus/long-form-mounts-ports.compose.yaml",
  "corpus/runtime-knobs.compose.yaml",
  "corpus/service-extensions.compose.yaml",
  "corpus/service-profiles.compose.yaml",
  "corpus/udp-port.compose.yaml",
  "upstream/different_networks.compose.yaml",
  "upstream/simple_configfile.compose.yaml",
  "upstream/simple_lifecycle.compose.yaml",
  "upstream/simple_network.compose.yaml",
  "upstream/simple_secretfile.compose.yaml",
  "upstream/simple_volume.compose.yaml",
] as const;

type RequiredRawFixturePath = (typeof REQUIRED_RAW_FIXTURE_PATHS)[number];

const isRequiredRawFixturePath = (path: string): path is RequiredRawFixturePath =>
  REQUIRED_RAW_FIXTURE_PATHS.some((candidate) => candidate === path);

const servicePlan = (context: OutcomeContext, name: string): ServicePlan => {
  const service = context.plan.services[ServiceName.make(name)];
  expect(service).toBeDefined();
  if (service === undefined) throw new ComposeFixtureOutcomeError(`Missing planned fixture service ${name}`);
  return service;
};

const expectations = {
  "corpus/depends-on-conditions.compose.yaml": (context) => {
    expect(servicePlan(context, "api").dependsOn).toEqual([
      { service: ServiceName.make("database"), condition: "service_healthy", required: true },
    ]);
    expect(servicePlan(context, "api").extensions.compose).toMatchObject({
      depends_on: { database: { restart: true } },
    });
    expect(servicePlan(context, "database").healthcheck).toEqual({
      kind: "command",
      command: "pg_isready -U postgres",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      retries: 3,
    });
  },
  "corpus/environment-files-labels.compose.yaml": (context) => {
    const worker = servicePlan(context, "worker");
    expect(worker.environment).toEqual({
      APP_ENV: "production",
      QUEUE: "critical",
      US476_WORKER_0: "fixture-0",
      US476_WORKER_1: "fixture-1",
    });
    expect(worker.workingDirectory).toBe(PortablePath.make("/workspace"));
    expect(worker.extensions.compose).toMatchObject({
      labels: {
        "com.example.role": "worker",
        "com.example.tier": "background",
      },
    });
  },
  "corpus/healthcheck.compose.yaml": (context) => {
    expect(servicePlan(context, "gateway").healthcheck).toEqual({
      kind: "command",
      command: "curl --fail http://localhost:8080/health || exit 1",
      intervalSeconds: 30,
      timeoutSeconds: 30,
      retries: 5,
      startPeriodSeconds: 90,
    });
  },
  "corpus/long-form-mounts-ports.compose.yaml": (context) => {
    const web = servicePlan(context, "web");
    expect(web.endpoints).toEqual([
      {
        _tag: "published",
        port: 8080,
        protocol: "tcp",
        publication: { bindAddress: "127.0.0.1", hostPort: 8443 },
        name: "web-secure",
        appProtocol: "https",
      },
    ]);
    expect(web.mounts).toContainEqual({
      type: "bind",
      source: resolve(context.appRoot, "src"),
      target: PortablePath.make("/workspace/src"),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough",
    });
    expect(web.storage).toContainEqual({
      store: `${context.plan.name}-cache`,
      target: PortablePath.make("/var/cache/app"),
      readOnly: false,
      subpath: "web",
    });
    expect(web.extensions.compose).toMatchObject({
      tmpfs: [{ target: "/run/app", size: 67_108_864, mode: 1770 }],
    });
  },
  "corpus/runtime-knobs.compose.yaml": (context) => {
    expect(servicePlan(context, "database").extensions.compose).toMatchObject({
      extra_hosts: { "host.internal": "host-gateway" },
      cap_add: ["IPC_LOCK"],
      tmpfs: ["/run:size=64m,mode=1770"],
      shm_size: 268_435_456,
      restart: "unless-stopped",
      ulimits: { nofile: { soft: 4096, hard: 8192 } },
      deploy: {
        resources: {
          limits: { cpus: "2.0", memory: 1_073_741_824, pids: 256 },
          reservations: { cpus: "0.5", memory: 268_435_456 },
        },
      },
    });
  },
  "corpus/service-extensions.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "worker").extensions.compose, "x-vendor")).toEqual({
      "x-nested": { list: [1, 2], flag: true },
    });
  },
  "corpus/service-profiles.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "debugger").extensions.compose, "profiles")).toEqual([
      "debug",
      "tools",
    ]);
  },
  "corpus/udp-port.compose.yaml": (context) => {
    expect(servicePlan(context, "dns").endpoints).toEqual([
      {
        _tag: "published",
        port: 5353,
        protocol: "udp",
        publication: { hostPort: 5353 },
      },
    ]);
  },
  "upstream/different_networks.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "entry").extensions.compose, "networks")).toEqual({
      entrynetwork: {},
    });
    expect(valueAt(servicePlan(context, "target").extensions.compose, "networks")).toEqual({
      targetnetwork: {},
    });
  },
  "upstream/simple_configfile.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "entry").extensions.compose, "configs")).toEqual([
      { source: "test_config", target: "/volumes/test_config.txt" },
    ]);
  },
  "upstream/simple_lifecycle.compose.yaml": (context) => {
    expect(servicePlan(context, "test1").artifact).toEqual({
      kind: "ref",
      ref: "composespec/conformance-tests-server",
    });
  },
  "upstream/simple_network.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "entry").extensions.compose, "networks")).toEqual({
      mynetwork: {},
    });
    expect(valueAt(servicePlan(context, "target").extensions.compose, "networks")).toEqual({
      mynetwork: {},
    });
  },
  "upstream/simple_secretfile.compose.yaml": (context) => {
    expect(valueAt(servicePlan(context, "entry").extensions.compose, "secrets")).toEqual([
      { source: "test_secret", target: "/volumes/test_secret.txt" },
    ]);
  },
  "upstream/simple_volume.compose.yaml": (context) => {
    const entry = servicePlan(context, "entry");
    expect(entry.artifact).toEqual({
      kind: "ref",
      ref: "composespec/conformance-tests-server",
    });
    expect(entry.endpoints).toEqual([
      {
        _tag: "published",
        port: 8080,
        protocol: "tcp",
        publication: { hostPort: 8080 },
      },
    ]);
    expect(entry.mounts).toContainEqual({
      type: "bind",
      source: resolve(context.appRoot, "test_volume.txt"),
      target: PortablePath.make("/volumes/test_volume.txt"),
      readOnly: false,
      realization: "passthrough",
    });
  },
} satisfies Readonly<Record<RequiredRawFixturePath, RawFixtureExpectation>>;

export const assertRawFixtureOutcome = (relativePath: string, context: OutcomeContext): void => {
  if (isRequiredRawFixturePath(relativePath)) expectations[relativePath](context);
};
