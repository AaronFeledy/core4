import { describe, expect, test } from "bun:test";

import { buildKeyForService } from "@lando/engine/services/build-key";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient, layer as makeProviderLayer } from "@lando/provider-lando";
import { sha256Hex } from "@lando/sdk/digest";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LandofileShape,
  ProviderId,
  type ServiceConfig,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  RuntimeProvider,
  type ServiceFeatureDefinition,
  type ServiceType,
  type ServiceTypeProjectFileInput,
} from "@lando/sdk/services";
import { DateTime, Effect, Schema } from "effect";

import {
  NODE_FEATURE_ID,
  node22ServiceType,
  nodeServiceFeature,
  nodeServiceType,
} from "../src/services/node.ts";
import { PHP_FEATURE_ID, php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { runBuiltImage } from "./support/run-built-image.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: "2026-09-13T00:00:00Z",
  source: "package-installs.integration.test",
  runtime: 4 as const,
};
const planMetadata = {
  ...metadata,
  resolvedAt: DateTime.makeUnsafe(metadata.resolvedAt),
};

const decodeService = (appId: AppId, raw: Record<string, unknown>): ServiceConfig => {
  const service = Schema.decodeUnknownSync(LandofileShape)({
    name: String(appId),
    services: { [serviceName]: raw },
  }).services?.[serviceName];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

interface PlanRequest {
  readonly appId: AppId;
  readonly serviceType: ServiceType;
  readonly featureId: string;
  readonly feature: ServiceFeatureDefinition;
  readonly raw: Record<string, unknown>;
  readonly projectFiles?: ReadonlyArray<ServiceTypeProjectFileInput>;
}

const planFor = async (request: PlanRequest): Promise<readonly [AppPlan, ServicePlan]> => {
  const { appId, serviceType, featureId, feature, raw, projectFiles } = request;
  const appRoot = AbsolutePath.make(`/tmp/${String(appId)}`);
  const service = await composeServicePlan({
    serviceType,
    service: decodeService(appId, raw),
    appRoot,
    appName: String(appId),
    serviceName: String(serviceName),
    metadata,
    featureOverrides: new Map([[featureId, feature]]),
    ...(projectFiles === undefined ? {} : { projectFiles }),
  });
  const plan: AppPlan = {
    id: appId,
    name: String(appId),
    slug: String(appId),
    root: appRoot,
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    stores: [],
    fileSync: [],
    metadata: planMetadata,
    extensions: {},
  };
  return [plan, service] as const;
};

const liveProvider = async (socketPath: string) =>
  Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          platform: "linux",
          podmanApi: makePodmanApiClient(socketPath),
          sanitizeAppliedPlan: stripHostProxyRunLando,
        }),
      ),
    ),
  );

describe("catalog package installs — live provider", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "installs global npm packages into the stock node image",
    async () => {
      // Given a node service authoring globals,
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await liveProvider(socket.socketPath);
      const [plan, service] = await planFor({
        appId: AppId.make("node-globals-smoke"),
        serviceType: node22ServiceType,
        featureId: NODE_FEATURE_ID,
        feature: nodeServiceFeature,
        raw: { type: "node:22", globals: { cowsay: "1.6.0" } },
      });
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When the artifact is built,
      const artifact = await Effect.runPromise(
        Effect.scoped(
          provider.buildArtifact({
            labels: { "dev.lando.test": crypto.randomUUID() },
            app: plan.id,
            service: serviceName,
            plan,
            buildKey,
            ref: `lando-build-test-${crypto.randomUUID()}-node`,
          }),
        ),
      );
      try {
        const listed = await runBuiltImage(socket.socketPath, artifact.ref, ["npm", "ls", "-g", "--depth=0"]);
        const invoked = await runBuiltImage(socket.socketPath, artifact.ref, ["cowsay", "moo"]);

        // Then the package is installed and callable by name.
        expect(listed.exitCode, listed.stderr).toBe(0);
        expect(listed.stdout).toContain("cowsay@1.6.0");
        expect(invoked.exitCode, invoked.stderr).toBe(0);
        expect(invoked.stdout).toContain("moo");
      } finally {
        expect(
          (await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind,
        ).toBe("removed");
      }
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "installs global Composer packages into the stock PHP image",
    async () => {
      // Given a PHP service authoring the composer object form,
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await liveProvider(socket.socketPath);
      const [plan, service] = await planFor({
        appId: AppId.make("composer-packages-smoke"),
        serviceType: php83ServiceType,
        featureId: PHP_FEATURE_ID,
        feature: phpServiceFeature,
        raw: {
          type: "php:8.3",
          composer: { version: "2", packages: { "squizlabs/php_codesniffer": "^3.10" } },
        },
      });
      const buildKey = await Effect.runPromise(buildKeyForService(provider, service));

      // When the artifact is built,
      const artifact = await Effect.runPromise(
        Effect.scoped(
          provider.buildArtifact({
            labels: { "dev.lando.test": crypto.randomUUID() },
            app: plan.id,
            service: serviceName,
            plan,
            buildKey,
            ref: `lando-build-test-${crypto.randomUUID()}-composer`,
          }),
        ),
      );
      try {
        const version = await runBuiltImage(socket.socketPath, artifact.ref, ["phpcs", "--version"]);
        const shown = await runBuiltImage(socket.socketPath, artifact.ref, [
          "sh",
          "-c",
          "COMPOSER_HOME=/usr/local/composer COMPOSER_ALLOW_SUPERUSER=1 composer global show",
        ]);

        // Then the tool is on PATH and recorded in the global Composer home.
        expect(version.exitCode, version.stderr).toBe(0);
        expect(version.stdout).toContain("PHP_CodeSniffer");
        expect(shown.exitCode, shown.stderr).toBe(0);
        expect(shown.stdout).toContain("squizlabs/php_codesniffer");
      } finally {
        expect(
          (await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind,
        ).toBe("removed");
      }
    },
    600_000,
  );
});

type LiveProvider = Awaited<ReturnType<typeof liveProvider>>;

interface PackageManagerScenario {
  readonly appId: AppId;
  readonly major: string;
  readonly packageManager: string;
  readonly expectedVersion: string;
  readonly user?: string;
}

const nodeProjectFiles = (
  major: string,
  packageManager: string,
): ReadonlyArray<ServiceTypeProjectFileInput> =>
  [
    { path: ".nvmrc", text: `${major}\n` },
    { path: "package.json", text: JSON.stringify({ name: "package-manager-smoke", packageManager }) },
  ].map(({ path, text }) => ({ path, present: true as const, text, sha256: sha256Hex(text) }));

const containerEnvironment = (plan: ServicePlan): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.entries(plan.environment).flatMap(([name, value]) =>
      typeof value === "string" ? [[name, value] as const] : [],
    ),
  );

const buildProvisionedNode = async (provider: LiveProvider, scenario: PackageManagerScenario) => {
  const [appPlan, servicePlan] = await planFor({
    appId: scenario.appId,
    serviceType: nodeServiceType,
    featureId: NODE_FEATURE_ID,
    feature: nodeServiceFeature,
    raw: { type: "node", ...(scenario.user === undefined ? {} : { user: scenario.user }) },
    projectFiles: nodeProjectFiles(scenario.major, scenario.packageManager),
  });
  const buildKey = await Effect.runPromise(buildKeyForService(provider, servicePlan));
  const artifact = await Effect.runPromise(
    Effect.scoped(
      provider.buildArtifact({
        labels: { "dev.lando.test": crypto.randomUUID() },
        app: appPlan.id,
        service: serviceName,
        plan: appPlan,
        buildKey,
        ref: `lando-build-test-${crypto.randomUUID()}-node-pm`,
      }),
    ),
  );
  return { artifact, environment: containerEnvironment(servicePlan) };
};

const packageManagerScenarios: ReadonlyArray<PackageManagerScenario> = [
  {
    appId: AppId.make("node-pm-26-yarn1"),
    major: "26",
    packageManager: "yarn@1.22.22",
    expectedVersion: "1.22.22",
  },
  {
    appId: AppId.make("node-pm-24-yarn1"),
    major: "24",
    packageManager: "yarn@1.22.22",
    expectedVersion: "1.22.22",
  },
  {
    appId: AppId.make("node-pm-26-yarn4"),
    major: "26",
    packageManager: "yarn@4.18.1",
    expectedVersion: "4.18.1",
  },
  {
    appId: AppId.make("node-pm-24-yarn4"),
    major: "24",
    packageManager: "yarn@4.18.1",
    expectedVersion: "4.18.1",
  },
  {
    appId: AppId.make("node-pm-26-pnpm"),
    major: "26",
    packageManager: "pnpm@9.15.0",
    expectedVersion: "9.15.0",
  },
  {
    appId: AppId.make("node-pm-24-pnpm"),
    major: "24",
    packageManager: "pnpm@9.15.0",
    expectedVersion: "9.15.0",
  },
  {
    appId: AppId.make("node-pm-26-yarn1-user"),
    major: "26",
    packageManager: "yarn@1.22.22",
    expectedVersion: "1.22.22",
    user: "node",
  },
  {
    appId: AppId.make("node-pm-26-yarn4-user"),
    major: "26",
    packageManager: "yarn@4.18.1",
    expectedVersion: "4.18.1",
    user: "node",
  },
  {
    appId: AppId.make("node-pm-26-pnpm-user"),
    major: "26",
    packageManager: "pnpm@9.15.0",
    expectedVersion: "9.15.0",
    user: "node",
  },
];

describe("node packageManager provisioning — live provider", () => {
  for (const scenario of packageManagerScenarios) {
    const manager = scenario.packageManager.slice(0, scenario.packageManager.indexOf("@"));
    test.skipIf(resolveLiveProviderSocket() === undefined)(
      `runs ${scenario.packageManager} on node:${scenario.major}${scenario.user === undefined ? "" : ` as ${scenario.user}`}`,
      async () => {
        // Given a bare node service whose package.json declares a package manager,
        const socket = resolveLiveProviderSocket();
        expect(socket).toBeDefined();
        if (socket === undefined) return;
        const provider = await liveProvider(socket.socketPath);
        const { artifact, environment } = await buildProvisionedNode(provider, scenario);
        try {
          // When the container starts offline with the plan's environment (which points
          // Corepack at the cached managers) and runs the shim outside a project,
          const shown = await runBuiltImage(socket.socketPath, artifact.ref, [manager, "--version"], {
            env: environment,
            offline: true,
            ...(scenario.user === undefined ? {} : { user: scenario.user }),
          });

          // Then Corepack serves the exact version package.json declared from the image cache.
          expect(shown.exitCode, shown.stderr).toBe(0);
          expect(shown.stdout.trim()).toBe(scenario.expectedVersion);
        } finally {
          expect(
            (await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind,
          ).toBe("removed");
        }
      },
      600_000,
    );
  }
});
