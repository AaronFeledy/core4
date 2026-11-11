import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { networkOwnershipLabels } from "@lando/container-runtime/native-ownership";
import { bringUp } from "@lando/container-runtime/podman/bring-up";
import { inspect } from "@lando/container-runtime/podman/inspect";
import {
  fixtureContainerLabels as commonContainerLabels,
  fixtureHelperOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import { makeLandoPaths } from "@lando/paths";
import type { CertificatePair } from "@lando/sdk/certificates";
import {
  type AppPlan,
  CertificateName,
  PortablePath,
  type ServicePlan,
  landoAppNetworkName,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import {
  BuildOrchestrator,
  CertificateAuthority,
  PathsService,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { Effect, Layer, Redacted, Result } from "effect";

import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import { serviceWithArtifact } from "../../src/services/build-artifact-runner.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const restartAfterIssuing = async (rootAfterStart: "kept" | "rotated") => {
  const root = await mkdtemp(join(tmpdir(), "lando-restart-certificates-"));
  try {
    const paths = makeLandoPaths({
      platform: "linux",
      home: root,
      env: {},
      userDataRoot: join(root, "data"),
    });
    const leaf = serviceCertificatePaths(paths.certsDir, routeOwnerFromPlan(plan).ownerKey, "web");
    const authority: { root: string; issue: CertificatePair } = {
      root: TEST_CERTIFICATES.rootA,
      issue: TEST_CERTIFICATES.service,
    };
    const ca = CertificateAuthority.of({
      id: "fake",
      setup: () => Effect.void,
      root: Effect.sync(() => ({ certificate: authority.root })),
      issueCert: () =>
        Effect.sync(() => ({
          certificate: authority.issue.certificate,
          privateKey: Redacted.make(authority.issue.privateKey),
          root: { certificate: authority.root },
        })),
    });
    const certificates = Layer.mergeAll(
      Layer.succeed(PathsService, paths),
      Layer.succeed(
        CertificateAuthorityResolver,
        CertificateAuthorityResolver.of({ resolve: Effect.succeed(ca) }),
      ),
    );
    const bind = (source: string, target: string) => ({
      type: "bind" as const,
      source,
      target: PortablePath.make(target),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough" as const,
      origin: "service" as const,
    });
    const declared: ServicePlan = {
      ...web,
      certs: { cn: CertificateName.make("web.app.internal"), sans: [], caId: "fake" },
      mounts: [
        bind(leaf.certPath, "/etc/lando/certs/leaf/web.crt"),
        bind(leaf.keyPath, "/etc/lando/certs/leaf/web.key"),
      ],
    };
    const desired: AppPlan = { ...plan, services: { [web.name]: declared } };
    const realized = serviceWithArtifact(declared, { providerId: plan.provider, ref: "node:22-alpine" });
    const applied: AppPlan = { ...desired, services: { [web.name]: realized } };

    // Given: the running container was created from the plan start stamped with the rootA pair
    const started = await Effect.runPromise(
      prepareServiceCertificates(applied).pipe(Effect.provide(certificates)),
    );
    const startedService = started.services[web.name];
    if (startedService === undefined) throw new TypeError("missing started web service");
    const labels = commonContainerLabels(started, startedService);
    if (rootAfterStart === "rotated") {
      authority.root = TEST_CERTIFICATES.rootB;
      authority.issue = TEST_CERTIFICATES.serviceFromRootB;
    }

    const mutations: string[] = [];
    let running = true;
    const privateNetworkName = landoAppNetworkName(applied);
    const sharedNetworkName = landoSharedNetworkName(applied);
    if (privateNetworkName === undefined || sharedNetworkName === undefined)
      throw new TypeError("Restart fixture requires private and shared network names.");
    const api: EngineHttpApi = {
      request: (request) =>
        Effect.sync(() => {
          if (
            request.method === "GET" &&
            request.path === `/networks/${encodeURIComponent(privateNetworkName)}`
          )
            return {
              status: 200,
              body: JSON.stringify({
                Id: "retained-private-network",
                Name: privateNetworkName,
                Driver: "bridge",
                Labels: networkOwnershipLabels(applied),
              }),
            };
          if (
            request.method === "GET" &&
            request.path === `/networks/${encodeURIComponent(sharedNetworkName)}`
          )
            return { status: 200, body: "{}" };
          if (request.method === "GET" && request.path.endsWith("/json"))
            return {
              status: 200,
              body: JSON.stringify({
                Id: "retained-container",
                Config: { Labels: labels },
                State: { Running: running },
                Mounts: [],
              }),
            };
          if (request.path.endsWith("/start")) running = true;
          return { status: 204, body: "" };
        }),
    };
    const ctx = { providerId: "lando", remediation: "Retry.", env: {} };
    const harness = makeHarness({
      plannedApp: desired,
      exec: () => Effect.die("Selected restart must not seed a GPG home"),
      inspect: (target) => inspect(target.plan ?? desired, target, { api, ctx, ...fixtureHelperOptions }),
      onStop: () => {
        mutations.push("stop");
        running = false;
      },
      apply: (runtimePlan, options) => {
        mutations.push("apply");
        return bringUp(runtimePlan, {
          ...fixtureHelperOptions,
          ...options,
          api,
          ctx,
          ensureImage: () => Effect.die("restart must not pull"),
          resolveServiceEnvironment: () => Effect.succeed({}),
        });
      },
    });
    // When
    const outcome = await Effect.runPromise(
      Effect.result(
        restartApp(
          { services: [web.name] },
          { plan: desired, root: desired.root, app: { kind: "user", id: desired.id, root: desired.root } },
        ),
      ).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          resolveAppliedPlan: () => Effect.succeed(applied),
        }),
        Effect.provideService(BuildOrchestrator, {
          build: () => Effect.die("restart must not build"),
          buildApp: () => Effect.die("restart must not build app"),
        }),
        Effect.provide(certificates),
        Effect.provide(harness.layer),
      ),
    );
    return { outcome, mutations };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("selected restart keeps a container whose certificate material is unchanged", async () => {
  const { outcome, mutations } = await restartAfterIssuing("kept");
  expect(Result.isSuccess(outcome)).toBe(true);
  expect(mutations).toEqual(["stop", "apply"]);
});

test("selected restart rejects changed certificate material before any service stops", async () => {
  const { outcome, mutations } = await restartAfterIssuing("rotated");
  expect(Result.isFailure(outcome) ? outcome.failure : undefined).toMatchObject({
    _tag: "ServiceRestartWouldRecreateError",
    reason: "config",
  });
  expect(mutations).toEqual([]);
});
