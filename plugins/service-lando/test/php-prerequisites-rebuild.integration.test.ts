import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import { libpodPullDialect } from "@lando/container-runtime/dialect";
import type { EngineHttpRequest } from "@lando/container-runtime/engine-api";
import { buildContainerArtifact } from "@lando/container-runtime/image-build";
import { pullImage } from "@lando/container-runtime/image-pull";
import * as BuildOrchestratorLayer from "@lando/engine/services/build-orchestrator";
import * as LandoEventService from "@lando/engine/services/event-service";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeLandoPaths } from "@lando/paths";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { BuildOrchestrator, PathsService, RuntimeProviderRegistry, StateStore } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import {
  PHP_PREREQUISITES_STEP_ID,
  phpPrerequisitesBuildKeyInputs,
} from "../src/services/php-prerequisites.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("php-moved-base");
const serviceName = ServiceName.make("web");
const baseTag = "localhost/lando-php-moved-base:bookworm";
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-21T00:00:00Z"),
  source: "php-prerequisites-rebuild.integration.test",
  runtime: 4 as const,
};

type StoredImage = {
  readonly id: string;
  readonly digest: string;
  readonly marker: string;
};

const firstBase: StoredImage = {
  id: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
  digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  marker: "first",
};
const secondBase: StoredImage = {
  id: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
  digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  marker: "second",
};

const collect = async (input: AsyncIterable<Uint8Array> | undefined): Promise<Uint8Array> => {
  if (input === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
};

const tarText = (field: Uint8Array): string => new TextDecoder().decode(field).replace(/\0.*$/u, "");

const dockerfileFromTar = (archive: Uint8Array): string => {
  let offset = 0;
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarText(header.subarray(0, 100));
    const size = Number.parseInt(tarText(header.subarray(124, 136)) || "0", 8);
    const contentOffset = offset + 512;
    if (name === "Dockerfile") {
      return new TextDecoder().decode(archive.subarray(contentOffset, contentOffset + size));
    }
    offset = contentOffset + size + ((512 - (size % 512)) % 512);
  }
  return "";
};

const imagePath = (path: string): string | undefined => {
  const match = /^\/(?:libpod\/)?images\/([^/]+)\/json$/u.exec(path);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
};

const makeEngine = () => {
  const tags = new Map<string, StoredImage>([[baseTag, firstBase]]);
  const images = new Map<string, StoredImage>([
    [firstBase.id, firstBase],
    [firstBase.digest, firstBase],
    [secondBase.id, secondBase],
    [secondBase.digest, secondBase],
  ]);
  const layerCache = new Map<string, StoredImage>();
  let next = 0;

  const lookup = (reference: string): StoredImage | undefined => {
    const digestIndex = reference.indexOf("@");
    if (digestIndex !== -1) return images.get(reference.slice(digestIndex + 1));
    return tags.get(reference) ?? images.get(reference);
  };

  const inspectBody = (image: StoredImage): string =>
    JSON.stringify({
      Id: image.id,
      Digest: image.digest,
      RepoDigests: [`${baseTag}@${image.digest}`],
      Config: { User: "root" },
    });

  const request = (input: EngineHttpRequest) =>
    Effect.gen(function* () {
      if (input.method === "GET") {
        const reference = imagePath(input.path);
        const image = reference === undefined ? undefined : lookup(reference);
        return image === undefined ? { status: 404, body: "{}" } : { status: 200, body: inspectBody(image) };
      }
      if (input.path.startsWith("/libpod/images/pull")) {
        return { status: 404, body: '{"error":"local tag is not in a registry"}' };
      }
      if (!input.path.startsWith("/build?")) return { status: 404, body: "{}" };
      const tag = new URL(`http://build${input.path}`).searchParams.get("t");
      if (tag === null) return { status: 400, body: '{"error":"missing tag"}' };
      const dockerfile = dockerfileFromTar(yield* Effect.promise(() => collect(input.stdin)));
      const cached = layerCache.get(dockerfile);
      if (cached !== undefined) {
        tags.set(tag, cached);
        images.set(tag, cached);
        return { status: 200, body: `{"aux":{"Digest":"${cached.digest}"}}\n` };
      }
      const from = /^FROM\s+(\S+)/u.exec(dockerfile)?.[1];
      const parent = from === undefined ? undefined : lookup(from);
      if (parent === undefined) {
        return { status: 400, body: `{"error":"unknown FROM ${from ?? ""}"}` };
      }
      next += 1;
      const built: StoredImage = {
        id: `sha256:${String(next).padStart(64, "0")}`,
        digest: parent.digest,
        marker: parent.marker,
      };
      layerCache.set(dockerfile, built);
      tags.set(tag, built);
      images.set(tag, built);
      images.set(built.id, built);
      return { status: 200, body: `{"aux":{"Digest":"${built.digest}"}}\n` };
    });

  return {
    retag: (image: StoredImage) => {
      tags.set(baseTag, image);
    },
    runningBase: (reference: string): StoredImage | undefined => lookup(reference),
    request,
  };
};

const servicePlan = (): ServicePlan => ({
  name: serviceName,
  type: "php:8.2",
  provider: providerId,
  primary: true,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  artifact: { kind: "ref", ref: baseTag },
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [
        {
          id: PHP_PREREQUISITES_STEP_ID,
          phase: "build",
          command: "true",
          user: "root",
          buildKeyInputs: phpPrerequisitesBuildKeyInputs(),
        },
      ],
    },
  },
});

const appPlan = (service: ServicePlan): AppPlan => ({
  id: appId,
  name: String(appId),
  slug: String(appId),
  root: AbsolutePath.make("/tmp/php-moved-base"),
  provider: providerId,
  services: { [serviceName]: service },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const providerLayer = (engine: ReturnType<typeof makeEngine>) => {
  const provider = {
    ...TestRuntimeProvider,
    id: providerId,
    displayName: "Lando",
    capabilities: { ...TestRuntimeProvider.capabilities, artifactBuild: true, artifactPull: true },
    pullArtifact: (spec: { readonly ref: string; readonly policy?: "always" | "missing" | "never" }) =>
      pullImage(engine, spec.ref, {
        ctx: { providerId, remediation: "Retry the rebuild." },
        dialect: libpodPullDialect,
        ...(spec.policy === undefined ? {} : { policy: spec.policy }),
      }).pipe(
        Effect.map((result) => ({
          providerId,
          ref: result.ref,
          ...(result.digest === undefined ? {} : { digest: result.digest }),
        })),
      ),
    buildArtifact: (spec: Parameters<typeof buildContainerArtifact>[0]) =>
      Effect.scoped(buildContainerArtifact(spec, { providerId, api: engine })),
  };
  return Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(provider.capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
};

const orchestratorLayer = (engine: ReturnType<typeof makeEngine>) => {
  const dependencies = Layer.mergeAll(
    LandoEventService.layer,
    Layer.succeed(PathsService, makeLandoPaths()),
    providerLayer(engine),
    Layer.succeed(StateStore, makeTestStateStore().service),
  );
  return Layer.mergeAll(dependencies, BuildOrchestratorLayer.layer.pipe(Layer.provide(dependencies)));
};

describe("PHP prerequisites rebuild: moved base tag", () => {
  test("rebuild picks up a retagged upstream base digest", async () => {
    const engine = makeEngine();
    const plan = appPlan(servicePlan());
    const layer = orchestratorLayer(engine);

    const first = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan)).pipe(
        Effect.provide(layer),
      ),
    );
    const firstRef = first.services[serviceName]?.artifact;
    expect(firstRef?.kind).toBe("ref");
    if (firstRef?.kind !== "ref") return;
    expect(engine.runningBase(firstRef.ref)?.digest).toBe(firstBase.digest);

    engine.retag(secondBase);

    const rebuilt = await Effect.runPromise(
      Effect.flatMap(BuildOrchestrator, (orchestrator) => orchestrator.build(plan, { refresh: true })).pipe(
        Effect.provide(layer),
      ),
    );
    const rebuiltRef = rebuilt.services[serviceName]?.artifact;
    expect(rebuiltRef?.kind).toBe("ref");
    if (rebuiltRef?.kind !== "ref") return;
    expect(engine.runningBase(rebuiltRef.ref)?.digest).toBe(secondBase.digest);
  });
});
