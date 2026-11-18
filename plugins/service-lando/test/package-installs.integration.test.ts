import { describe, expect, test } from "bun:test";

import { buildKeyForService } from "@lando/engine/services/build-key";
import { acquireBuildTrees } from "@lando/engine/services/build-source-store";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { withRegistryBuildSources } from "@lando/engine/testing/build-source-store";
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
  node24ServiceType,
  node26ServiceType,
  nodeLtsServiceType,
  nodeServiceFeature,
  nodeServiceType,
} from "../src/services/node.ts";
import { PHP_FEATURE_ID, php83ServiceType, phpServiceFeature } from "../src/services/php.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import {
  BUILD_TEST_REF_PREFIX,
  NODE_PM_ARTIFACT_REF_SUFFIX,
  VENDORED_YARN_MARKER,
  runWithProject,
  vendoredYarnScript,
  yarnBerryPathRc,
  yarnClassicPathRc,
} from "./support/node-pm-fixtures.ts";
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
            ref: `${BUILD_TEST_REF_PREFIX}${crypto.randomUUID()}-node`,
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
            ref: `${BUILD_TEST_REF_PREFIX}${crypto.randomUUID()}-composer`,
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

interface NodeManagerScenario {
  readonly appId: AppId;
  readonly serviceType: ServiceType;
  readonly raw: Record<string, unknown>;
  readonly files: Readonly<Record<string, string>>;
  readonly projectFiles: ReadonlyArray<ServiceTypeProjectFileInput>;
  readonly user?: string;
  /** Shell body run with cwd `/app` after the mount is proven present. */
  readonly command: string;
  readonly expected: readonly string[];
  /** Substrings that must not appear (e.g. a vendored yarnPath marker). */
  readonly forbidden?: readonly string[];
  /**
   * When set, also run `command` with cwd at this path under `/app` and require
   * the same expected substrings (nested packageRoot coverage from both trees).
   */
  readonly alsoCwd?: string;
}

const fixtureInput = (path: string, text: string): ServiceTypeProjectFileInput => ({
  path,
  present: true,
  text,
  sha256: sha256Hex(text),
});

const projectFilesFrom = (
  files: Readonly<Record<string, string>>,
  includeVersionInput: boolean,
): ReadonlyArray<ServiceTypeProjectFileInput> =>
  Object.entries(files)
    // Planner inputs are package manifests and version files only; yarnrc/vendored
    // scripts exist on the read-only mount for runtime yarnPath coverage.
    .filter(([path]) => path.endsWith("package.json") || (includeVersionInput && path.endsWith(".nvmrc")))
    .map(([path, text]) => fixtureInput(path, text));

const buildNodeArtifact = async (provider: LiveProvider, scenario: NodeManagerScenario) => {
  const [appPlan, servicePlan] = await planFor({
    appId: scenario.appId,
    serviceType: scenario.serviceType,
    featureId: NODE_FEATURE_ID,
    feature: nodeServiceFeature,
    raw: scenario.raw,
    projectFiles: scenario.projectFiles,
  });
  const buildKey = await Effect.runPromise(buildKeyForService(provider, servicePlan));
  return withRegistryBuildSources((store) =>
    Effect.scoped(
      Effect.gen(function* () {
        const contextTrees = yield* acquireBuildTrees(servicePlan, store, {
          providerId,
          redact: (text) => text,
        });
        return yield* provider.buildArtifact({
          contextTrees,
          labels: { "dev.lando.test": crypto.randomUUID() },
          app: appPlan.id,
          service: serviceName,
          plan: appPlan,
          buildKey,
          ref: `${BUILD_TEST_REF_PREFIX}${crypto.randomUUID()}${NODE_PM_ARTIFACT_REF_SUFFIX}`,
        });
      }),
    ),
  );
};

const runScenario = async (scenario: NodeManagerScenario) => {
  const socket = resolveLiveProviderSocket();
  expect(socket).toBeDefined();
  if (socket === undefined) return;
  const provider = await liveProvider(socket.socketPath);
  const artifact = await buildNodeArtifact(provider, scenario);
  try {
    const check = async (cwd: string) => {
      const shown = await runWithProject({
        socketPath: socket.socketPath,
        image: artifact.ref,
        files: scenario.files,
        command: scenario.command,
        cwd,
        ...(scenario.user === undefined ? {} : { user: scenario.user }),
      });
      expect(shown.exitCode, `${shown.stdout}\n${shown.stderr}`).toBe(0);
      for (const expected of scenario.expected) expect(shown.stdout).toContain(expected);
      for (const forbidden of scenario.forbidden ?? []) {
        expect(`${shown.stdout}\n${shown.stderr}`).not.toContain(forbidden);
      }
      return shown;
    };

    const shown = await check("/app");
    if (scenario.alsoCwd !== undefined) {
      const nestedCwd = scenario.alsoCwd.startsWith("/") ? scenario.alsoCwd : `/app/${scenario.alsoCwd}`;
      await check(nestedCwd);
    }
    return shown;
  } finally {
    expect((await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind).toBe(
      "removed",
    );
  }
};

const yarnModernProject = {
  "package.json": JSON.stringify({
    private: true,
    packageManager: "yarn@4.18.1",
    scripts: { nested: "yarn --version && yarnpkg --version" },
  }),
  ".yarnrc.yml": yarnBerryPathRc(),
  ".yarn/releases/yarn-vendored.cjs": vendoredYarnScript,
} as const;

const yarnClassicProject = {
  "package.json": JSON.stringify({ private: true, packageManager: "yarn@1.22.22" }),
  ".yarnrc": yarnClassicPathRc(),
  ".yarn/releases/yarn-vendored.cjs": vendoredYarnScript,
} as const;

const pnpmProject = {
  "package.json": JSON.stringify({
    private: true,
    devEngines: { packageManager: { name: "pnpm", version: "9.15.0", onFail: "error" } },
  }),
} as const;

describe("node packageManager provisioning — live provider", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "runs the exact Yarn Berry release from an explicit LTS type, ignoring a real vendored yarnPath",
    async () => {
      const shown = await runScenario({
        appId: AppId.make("node-pm-explicit-yarn"),
        serviceType: nodeLtsServiceType,
        raw: { type: "node:lts", user: "node" },
        files: yarnModernProject,
        projectFiles: projectFilesFrom(yarnModernProject, false),
        user: "node",
        command:
          'export YARN_ENABLE_IMMUTABLE_INSTALLS=false && work=$(mktemp -d) && cp -R /app/. "$work" && cd "$work" && yarn install && yarn run nested && rm .yarnrc.yml && yarnpkg run nested',
        expected: ["4.18.1"],
        forbidden: [VENDORED_YARN_MARKER],
      });
      expect(shown?.stdout.split("\n").filter((line) => line === "4.18.1")).toHaveLength(4);
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "runs Yarn classic 1.22.22 on node:lts and node:22 with YARN_IGNORE_PATH against .yarnrc",
    async () => {
      for (const [serviceType, rawType, appId] of [
        [nodeLtsServiceType, "node:lts", "node-pm-yarn-classic-lts"],
        [node22ServiceType, "node:22", "node-pm-yarn-classic-22"],
      ] as const) {
        await runScenario({
          appId: AppId.make(appId),
          serviceType,
          raw: { type: rawType, user: "node" },
          files: yarnClassicProject,
          projectFiles: projectFilesFrom(yarnClassicProject, false),
          user: "node",
          command: 'test "$(yarn --version)" = 1.22.22 && test "$(yarnpkg --version)" = 1.22.22',
          expected: [],
          forbidden: [VENDORED_YARN_MARKER],
        });
      }
    },
    900_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "runs a devEngines-only pnpm as a non-root user with pinned pnpx dlx offline",
    async () => {
      const shown = await runScenario({
        appId: AppId.make("node-pm-devengines-pnpm"),
        serviceType: node24ServiceType,
        raw: { type: "node:24", user: "node" },
        files: pnpmProject,
        projectFiles: projectFilesFrom(pnpmProject, false),
        user: "node",
        command: [
          'test "$(pnpm --version)" = 9.15.0',
          "NODE_DEBUG=module pnpx >/tmp/pnpx.log 2>&1 || true",
          "grep -F 'load \"/usr/local/lib/lando/package-managers/pnpm/9.15.0/package/bin/pnpx.cjs\" for module' /tmp/pnpx.log",
          "node -e 'console.log(process.getuid())'",
        ].join(" && "),
        expected: [],
      });
      const uid = Number(shown?.stdout.split("\n").at(-1));
      expect(uid).toBeGreaterThan(0);
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "runs pnpm 10 and pnpm 11 on Node 26",
    async () => {
      const ten = {
        "package.json": JSON.stringify({ private: true, packageManager: "pnpm@10.33.0" }),
      };
      await runScenario({
        appId: AppId.make("node-pm-pnpm-10"),
        serviceType: node26ServiceType,
        raw: { type: "node:26" },
        files: ten,
        projectFiles: projectFilesFrom(ten, false),
        command: "pnpm --version",
        expected: ["10.33.0"],
      });

      const eleven = {
        "package.json": JSON.stringify({ private: true, packageManager: "pnpm@11.0.0" }),
      };
      await runScenario({
        appId: AppId.make("node-pm-pnpm-11"),
        serviceType: node26ServiceType,
        raw: { type: "node:26" },
        files: eleven,
        projectFiles: projectFilesFrom(eleven, false),
        command: "pnpm --version",
        expected: ["11.0.0"],
      });
    },
    900_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "keeps a nested dev-only pin when the app root pins another pnpm version, from both cwds",
    async () => {
      const files = {
        "package.json": JSON.stringify({ private: true, packageManager: "pnpm@9.15.0" }),
        "apps/web/package.json": JSON.stringify({
          private: true,
          devEngines: { packageManager: { name: "pnpm", version: "10.0.0" } },
        }),
      };
      await runScenario({
        appId: AppId.make("node-pm-nested-same-manager"),
        serviceType: node26ServiceType,
        raw: { type: "node:26", packageRoot: "apps/web" },
        files,
        projectFiles: projectFilesFrom(files, false),
        command: "pnpm --version",
        expected: ["10.0.0"],
        alsoCwd: "apps/web",
      });
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "keeps a nested dev-only pin when the app root pins a different manager, from both cwds",
    async () => {
      const files = {
        "package.json": JSON.stringify({ private: true, packageManager: "yarn@4.18.1" }),
        "apps/web/package.json": JSON.stringify({
          private: true,
          devEngines: { packageManager: { name: "pnpm", version: "9.15.0" } },
        }),
      };
      await runScenario({
        appId: AppId.make("node-pm-nested-other-manager"),
        serviceType: node26ServiceType,
        raw: { type: "node:26", packageRoot: "apps/web" },
        files,
        projectFiles: projectFilesFrom(files, false),
        command: "pnpm --version",
        expected: ["9.15.0"],
        alsoCwd: "apps/web",
      });
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "keeps bare inference working with a managed project",
    async () => {
      const files = {
        ".nvmrc": "26\n",
        "package.json": JSON.stringify({ private: true, packageManager: "pnpm@9.15.0" }),
      };
      await runScenario({
        appId: AppId.make("node-pm-bare-inferred"),
        serviceType: nodeServiceType,
        raw: { type: "node" },
        files,
        projectFiles: projectFilesFrom(files, true),
        command: "node --version && pnpm --version",
        expected: ["v26", "9.15.0"],
      });
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "fails closed when the installed package tree is missing",
    async () => {
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const provider = await liveProvider(socket.socketPath);
      const artifact = await buildNodeArtifact(provider, {
        appId: AppId.make("node-pm-missing-cache"),
        serviceType: node24ServiceType,
        raw: { type: "node:24" },
        files: pnpmProject,
        projectFiles: projectFilesFrom(pnpmProject, false),
        command: "pnpm --version",
        expected: [],
      });
      try {
        const shown = await runWithProject({
          socketPath: socket.socketPath,
          image: artifact.ref,
          files: pnpmProject,
          command: "mv /usr/local/lib/lando/package-managers/pnpm/9.15.0 /tmp/removed-pnpm && pnpm --version",
          asRoot: true,
        });
        expect(shown.exitCode).not.toBe(0);
        expect(shown.stdout).not.toContain("9.15.0");
        expect(shown.stderr).toContain("MODULE_NOT_FOUND");
      } finally {
        expect(
          (await Effect.runPromise(provider.removeArtifact({ ...artifact, pruneParents: true }))).kind,
        ).toBe("removed");
      }
    },
    600_000,
  );

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "fails the artifact build when the authored manager integrity does not match",
    async () => {
      const socket = resolveLiveProviderSocket();
      expect(socket).toBeDefined();
      if (socket === undefined) return;
      const files = {
        "package.json": JSON.stringify({
          private: true,
          packageManager: `pnpm@9.15.0+sha512.${"b".repeat(128)}`,
        }),
      };
      const [, servicePlan] = await planFor({
        appId: AppId.make("node-pm-bad-integrity"),
        serviceType: node24ServiceType,
        featureId: NODE_FEATURE_ID,
        feature: nodeServiceFeature,
        raw: { type: "node:24" },
        projectFiles: projectFilesFrom(files, false),
      });
      const result = await withRegistryBuildSources((store) =>
        Effect.result(
          Effect.scoped(acquireBuildTrees(servicePlan, store, { providerId, redact: (text) => text })),
        ),
      );
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(JSON.stringify(result.failure)).toMatch(/integrity|hash|checksum|mismatch/i);
      }
    },
    600_000,
  );
});
