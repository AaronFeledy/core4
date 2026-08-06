import { expect } from "bun:test";
import { resolve } from "node:path";

import type { ServiceConfig, ServicePlan } from "@lando/core/schema";
import { ServiceName } from "@lando/core/schema";

import { composeServiceDispositions } from "@lando/landofile/compose/dispositions";
import type { ComposeDispositionMatch } from "@lando/landofile/compose/rejections";
import {
  COMPOSE_FIXTURE_ASSERTIONS,
  type ComposePlanAssertion,
} from "./compose-fixture-assertion-metadata.ts";
import {
  ComposeFixtureOutcomeError,
  type OutcomeContext,
  fixtureEnvEntry,
  valueAt,
} from "./compose-fixture-outcome-values.ts";
import {
  matchedVolumes,
  normalizedSourceValue,
  requireDecodedSource,
  requireProducedValue,
} from "./compose-fixture-source-values.ts";

type ServiceOutcomeContext = {
  readonly appName: string;
  readonly appRoot: string;
  readonly match: ComposeDispositionMatch;
  readonly planService: ServicePlan;
  readonly service: ServiceConfig;
};

const expectedHealthcheck = (healthcheck: NonNullable<ServiceConfig["healthcheck"]>) => ({
  kind: healthcheck.kind ?? "command",
  intervalSeconds: healthcheck.intervalSeconds ?? 10,
  timeoutSeconds: healthcheck.timeoutSeconds ?? 5,
  retries: healthcheck.retries ?? 5,
  ...(healthcheck.command === undefined ? {} : { command: healthcheck.command }),
  ...(healthcheck.url === undefined ? {} : { url: healthcheck.url }),
  ...(healthcheck.port === undefined ? {} : { port: healthcheck.port }),
  ...(healthcheck.startPeriodSeconds === undefined
    ? {}
    : { startPeriodSeconds: healthcheck.startPeriodSeconds }),
});

const expectedEnvironment = (serviceName: string, service: ServiceConfig) => ({
  ...Object.fromEntries((service.envFile ?? []).map((_, index) => fixtureEnvEntry(serviceName, index))),
  ...(service.environment ?? {}),
});

const expectedEndpoints = (
  assertion: "internal-endpoints" | "published-endpoints",
  service: ServiceConfig,
): ServicePlan["endpoints"] =>
  assertion === "published-endpoints"
    ? (service.ports ?? []).map((port) => ({
        _tag: "published" as const,
        port: port.target,
        protocol: port.protocol === "udp" ? "udp" : "tcp",
        publication: {
          ...(port.hostIp === undefined ? {} : { bindAddress: port.hostIp }),
          ...(port.published === undefined ? {} : { hostPort: port.published }),
        },
        ...(port.name === undefined ? {} : { name: port.name }),
        ...(port.appProtocol === undefined ? {} : { appProtocol: port.appProtocol }),
      }))
    : (service.expose ?? []).map((port) => ({ _tag: "internal" as const, port, protocol: "tcp" as const }));

const assertArtifact = (
  assertion: "artifact-build" | "artifact-ref",
  context: ServiceOutcomeContext,
): void => {
  const { appRoot, planService, service } = context;
  requireProducedValue(planService.artifact, context.match, "ServicePlan.artifact");
  if (assertion === "artifact-ref") {
    if (service.image === undefined) throw new ComposeFixtureOutcomeError("Compose image missing");
    expect<unknown>(planService.artifact).toEqual({ kind: "ref", ref: service.image });
    return;
  }
  const build = service.build;
  if (build === undefined || !("context" in build) || typeof build.context !== "string") {
    throw new ComposeFixtureOutcomeError("Compose build missing");
  }
  expect<unknown>(planService.artifact).toEqual({
    kind: "build",
    context: resolve(appRoot, build.context),
    ...(build.args === undefined ? {} : { args: build.args }),
    ...(build.target === undefined ? {} : { target: build.target }),
    ...(build.dockerfileInline === undefined
      ? build.dockerfile === undefined
        ? {}
        : { spec: build.dockerfile }
      : { specInline: build.dockerfileInline }),
  });
};

const assertVolumes = (context: ServiceOutcomeContext): void => {
  const { appName, appRoot, planService, service } = context;
  const tmpfs = valueAt(planService, "extensions.compose.tmpfs");
  for (const volume of matchedVolumes(context.match, service)) {
    switch (volume.type) {
      case "bind": {
        const projected = planService.mounts.find((mount) => String(mount.target) === volume.target);
        requireProducedValue(projected, context.match, "ServicePlan.mounts");
        expect(projected).toMatchObject({
          type: "bind",
          source: resolve(appRoot, volume.source ?? ""),
          target: volume.target,
          readOnly: volume.readOnly,
          ...(volume.createHostPath === false ? { createHostPath: false } : {}),
        });
        break;
      }
      case "volume": {
        const projected = planService.storage.find((storage) => String(storage.target) === volume.target);
        requireProducedValue(projected, context.match, "ServicePlan.storage");
        expect<unknown>(projected).toEqual({
          store:
            volume.source === undefined
              ? `${appName}-${String(planService.name)}-${volume.target.split("/").filter(Boolean).join("-")}`
              : `${appName}-${volume.source}`,
          target: volume.target,
          readOnly: volume.readOnly,
          ...(volume.subpath === undefined ? {} : { subpath: volume.subpath }),
        });
        break;
      }
      case "tmpfs": {
        const projected = Array.isArray(tmpfs)
          ? tmpfs.find((entry) => valueAt(entry, "target") === volume.target)
          : undefined;
        requireProducedValue(projected, context.match, "ServicePlan.extensions.compose.tmpfs");
        expect(projected).toEqual({
          target: volume.target,
          ...(volume.readOnly ? { read_only: true } : {}),
          ...(volume.tmpfs?.size === undefined ? {} : { size: volume.tmpfs.size }),
          ...(volume.tmpfs?.mode === undefined ? {} : { mode: volume.tmpfs.mode }),
        });
        break;
      }
    }
  }
};

export const assertNormalizedMatch = (match: ComposeDispositionMatch, context: OutcomeContext): true => {
  if (match.service === undefined) throw new ComposeFixtureOutcomeError("Service match missing service name");
  const root = match.matrixPath.split(".")[0] ?? match.matrixPath;
  const entry = composeServiceDispositions[root];
  expect(entry?.planTarget).toBeDefined();
  if (entry?.planTarget === undefined)
    throw new ComposeFixtureOutcomeError(`Missing plan target for ${root}`);
  const service = context.landofile.services?.[ServiceName.make(match.service)];
  if (service === undefined) throw new ComposeFixtureOutcomeError(`Missing decoded service ${match.service}`);
  const metadata = COMPOSE_FIXTURE_ASSERTIONS[root];
  if (metadata === undefined) {
    throw new ComposeFixtureOutcomeError(`Missing plan assertion for ${root}`);
  }
  const planAssertion: ComposePlanAssertion = metadata.assertion;
  requireDecodedSource(
    normalizedSourceValue({
      match,
      service,
      assertion: planAssertion,
      configTarget: metadata.configTarget ?? root,
    }),
    match,
  );
  const planService = context.plan.services[ServiceName.make(match.service)];
  if (planService === undefined)
    throw new ComposeFixtureOutcomeError(`Missing planned service ${match.service}`);
  const serviceContext: ServiceOutcomeContext = {
    appName: context.plan.name,
    appRoot: context.appRoot,
    match,
    planService,
    service,
  };
  switch (planAssertion) {
    case "artifact-build":
    case "artifact-ref":
      assertArtifact(planAssertion, serviceContext);
      return true;
    case "dependencies":
      requireProducedValue(planService.dependsOn, match, "ServicePlan.dependsOn");
      expect<unknown>(planService.dependsOn).toEqual(
        (service.dependsOn ?? []).map((dependency) => ({
          service: dependency.service,
          condition: dependency.condition ?? "service_started",
          required: dependency.required ?? true,
        })),
      );
      return true;
    case "environment":
      requireProducedValue(planService.environment, match, "ServicePlan.environment");
      expect(planService.environment).toEqual(expectedEnvironment(match.service, service));
      return true;
    case "internal-endpoints":
    case "published-endpoints":
      requireProducedValue(planService.endpoints, match, "ServicePlan.endpoints");
      expect(planService.endpoints).toEqual(expectedEndpoints(planAssertion, service));
      return true;
    case "healthcheck":
      if (service.healthcheck === undefined) throw new ComposeFixtureOutcomeError("Healthcheck missing");
      requireProducedValue(planService.healthcheck, match, "ServicePlan.healthcheck");
      expect(planService.healthcheck).toEqual(expectedHealthcheck(service.healthcheck));
      return true;
    case "volumes":
      assertVolumes(serviceContext);
      return true;
    case "direct": {
      const target = entry.planTarget[0];
      if (target === undefined) throw new ComposeFixtureOutcomeError(`Empty plan target for ${root}`);
      const produced = valueAt(planService, target);
      requireProducedValue(produced, match, `ServicePlan.${target}`);
      expect(produced).toEqual(valueAt(service, metadata.configTarget ?? root));
      return true;
    }
    default: {
      const exhaustive: never = planAssertion;
      throw new ComposeFixtureOutcomeError(`Unhandled plan assertion: ${exhaustive}`);
    }
  }
};
