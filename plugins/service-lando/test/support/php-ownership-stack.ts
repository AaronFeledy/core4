import { expect } from "bun:test";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import * as Registry from "@lando/engine/plugins/registry";
import { buildKeyForService } from "@lando/engine/services/build-key";
import * as FileSystem from "@lando/engine/services/file-system";
import * as Planner from "@lando/engine/services/planner";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { loadAuthoredDocuments } from "@lando/landofile/root-compile";
import { bringDown, bringUp, makePodmanApiClient, layer as providerLayer } from "@lando/provider-lando";
import { emitLandofileYaml } from "@lando/sdk/landofile";
import {
  type CurrentExecutableAppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { AppPlanner, RuntimeProvider } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import * as ServiceLando from "../../src/index.ts";
import { acquireTempAppRoot, writeFixture } from "./live-app-scope.ts";
import { PhpAcceptanceError, type PhpEvidence } from "./php-ownership-evidence.ts";

export const web = ServiceName.make("web");
export const canonicalBase = "docker.io/library/php:8.3-apache-bookworm";
export const phpPage = `<?php
preg_match('/^Uid:\\s+\\d+\\s+(\\d+)/m', file_get_contents('/proc/self/status'), $uid);
header('X-Effective-Uid: ' . $uid[1]);
if (isset($_GET['marker'])) { error_log('php-error-' . $_GET['marker']); }
echo 'php-ownership:' . PHP_SAPI;
`;

export const buildSteps = (service: ServicePlan) =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      buildSteps: Schema.Array(Schema.Struct({ id: Schema.String, phase: Schema.String })),
    }),
  )(service.extensions["@lando/core/service-features"]).buildSteps;

export const requireWeb = (plan: CurrentExecutableAppPlan) => {
  const service = plan.services[web];
  if (service === undefined) throw new PhpAcceptanceError({ phase: "plan", message: "Missing web service" });
  return service;
};

export type PhpStack = {
  readonly plan: CurrentExecutableAppPlan;
  readonly authoredPlan: CurrentExecutableAppPlan;
  readonly api: ReturnType<typeof makePodmanApiClient>;
};

export type PhpFixture = {
  readonly service: Readonly<Record<string, unknown>>;
  readonly dockerfile?: string;
};

export const planPhpFixture = Effect.fn("PhpAcceptance.plan")(function* (
  root: string,
  fixture: { readonly id: string; readonly service: PhpFixture["service"] },
  capabilities: ProviderCapabilities,
) {
  const authored = Schema.decodeUnknownSync(LandofileShape)({
    name: fixture.id,
    runtime: 4,
    provider: "lando",
    router: { enabled: false },
    services: { web: { type: "php:8.3", via: "apache", port: 8080, certs: false, ...fixture.service } },
  });
  yield* writeFixture(root, ".lando.yml", emitLandofileYaml(Schema.encodeSync(LandofileShape)(authored)));
  const file = join(root, ".lando.yml");
  const loaded = yield* loadAuthoredDocuments(
    [{ file, value: Schema.encodeSync(LandofileShape)(authored) }],
    { appRoot: root, file },
  );
  return yield* Effect.flatMap(AppPlanner, (planner) => planner.plan(loaded, capabilities)).pipe(
    Effect.provide(Planner.layer),
    Effect.provide(
      Layer.mergeAll(ServiceLando.services, Registry.layerWith({}, [ServiceLando.plugin]), FileSystem.layer),
    ),
  );
});

export const acquirePhpStack = Effect.fn("PhpAcceptance.acquire")(function* (
  socketPath: string,
  fixture: PhpFixture,
  evidence: PhpEvidence,
) {
  evidence.phase = "plan";
  const root = yield* acquireTempAppRoot(`${evidence.id}-`);
  yield* Effect.promise(() => chmod(root, 0o755));
  yield* writeFixture(root, "index.php", phpPage);
  if (fixture.dockerfile !== undefined) yield* writeFixture(root, "Dockerfile", fixture.dockerfile);
  const api = makePodmanApiClient(socketPath);
  const provider = yield* RuntimeProvider.pipe(
    Effect.provide(
      providerLayer({ platform: "linux", podmanApi: api, sanitizeAppliedPlan: stripHostProxyRunLando }),
    ),
  );
  const authoredPlan = yield* planPhpFixture(
    root,
    { id: evidence.id, service: fixture.service },
    provider.capabilities,
  );
  // Transport isolation only: keep the real service/build plan, but never create or join a global network.
  const isolatedPlan = {
    ...authoredPlan,
    networking: { perAppBridge: authoredPlan.networking?.perAppBridge ?? null },
  };
  // Register BEFORE build/apply: even a partially failed bringUp owns resources needing teardown.
  evidence.cleanup = "pending";
  yield* Effect.addFinalizer(() =>
    bringDown(isolatedPlan, { api, volumes: true, purgeCaches: true }).pipe(
      Effect.timeout("60 seconds"),
      Effect.tap((result) =>
        Effect.sync(() => {
          evidence.cleanup = "completed";
          evidence.facts.cleanupChanged = result.changed;
        }),
      ),
      Effect.tapCause(() =>
        Effect.sync(() => {
          evidence.cleanup = "failed";
        }),
      ),
      Effect.orDie,
    ),
  );
  evidence.facts.app = authoredPlan.id;
  evidence.facts.provider = authoredPlan.provider;
  evidence.facts.ownedStores = authoredPlan.stores.map((store) => store.name);
  evidence.facts.ownedNetwork = isolatedPlan.networking.perAppBridge?.name ?? "";
  const service = requireWeb(authoredPlan);
  evidence.phase = "build";
  const buildKey = yield* buildKeyForService(provider, service);
  const artifact = yield* provider.buildArtifact({
    app: authoredPlan.id,
    service: web,
    plan: authoredPlan,
    buildKey,
  });
  evidence.facts.builtRef = artifact.ref;
  const plan: CurrentExecutableAppPlan = {
    ...isolatedPlan,
    services: {
      ...authoredPlan.services,
      [web]: { ...service, artifact: { kind: "ref", ref: artifact.ref } },
    },
  };
  evidence.phase = "start";
  const started = yield* bringUp(plan, { api });
  expect(started.changed).toBe(true);
  return { plan, authoredPlan, api } satisfies PhpStack;
});
