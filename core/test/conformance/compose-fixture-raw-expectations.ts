import { expect } from "bun:test";
import { resolve } from "node:path";

import { PortablePath, ServiceName, type ServicePlan } from "@lando/core/schema";

import { ComposeFixtureOutcomeError, type OutcomeContext } from "./compose-fixture-outcome-values.ts";

type RawFixtureExpectation = (context: OutcomeContext) => void;

export const REQUIRED_RAW_FIXTURE_PATHS = [
  "corpus/depends-on-conditions.compose.yaml",
  "corpus/environment-files-labels.compose.yaml",
  "corpus/healthcheck.compose.yaml",
  "corpus/long-form-mounts-ports.compose.yaml",
  "corpus/runtime-knobs.compose.yaml",
  "corpus/udp-port.compose.yaml",
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
} satisfies Readonly<Record<RequiredRawFixturePath, RawFixtureExpectation>>;

export const assertRawFixtureOutcome = (relativePath: string, context: OutcomeContext): void => {
  if (isRequiredRawFixturePath(relativePath)) expectations[relativePath](context);
};
