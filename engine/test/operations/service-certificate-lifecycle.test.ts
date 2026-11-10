import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { CaError, ProviderUnavailableError } from "@lando/sdk/errors";
import { type AppPlan, CertificateName, PortablePath } from "@lando/sdk/schema";
import { CertificateAuthority, PathsService } from "@lando/sdk/services";

import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import {
  type ServiceCertificatePaths,
  serviceCertificatePaths,
  serviceCertificatesOwnerDir,
} from "../../src/lifecycle/service-certificate-paths.ts";
import { destroyApp, destroyAppForTarget } from "../../src/operations/destroy.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopAppWithPlan } from "../../src/operations/stop.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const notInstalled = new CaError({
  message: "mkcert v1.4.4 is not installed at /bin/mkcert.",
  caId: "fake",
  remediation: "Run `lando setup` to download mkcert and install the local CA.",
});

const unavailableCa = CertificateAuthority.of({
  id: "fake",
  setup: () => Effect.void,
  root: Effect.fail(notInstalled),
  issueCert: () => Effect.fail(notInstalled),
});

const withCertificates = async (
  body: (input: {
    readonly certsPlan: AppPlan;
    readonly ownerDir: string;
    readonly leaf: ServiceCertificatePaths;
    readonly provide: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-certificate-lifecycle-"));
  try {
    const paths = makeLandoPaths({
      platform: "linux",
      home: root,
      env: {},
      userDataRoot: join(root, "data"),
    });
    const ownerKey = routeOwnerFromPlan(plan).ownerKey;
    const leaf = serviceCertificatePaths(paths.certsDir, ownerKey, "web");
    const bind = (source: string, target: string) => ({
      type: "bind" as const,
      source,
      target: PortablePath.make(target),
      readOnly: true,
      createHostPath: false,
      realization: "passthrough" as const,
      origin: "service" as const,
    });
    const certsPlan: AppPlan = {
      ...plan,
      services: {
        [web.name]: {
          ...web,
          certs: { cn: CertificateName.make("web.test-start.internal"), sans: [], caId: "fake" },
          mounts: [
            bind(leaf.certPath, "/etc/lando/certs/leaf/web.crt"),
            bind(leaf.keyPath, "/etc/lando/certs/leaf/web.key"),
          ],
        },
      },
    };
    await body({
      certsPlan,
      ownerDir: serviceCertificatesOwnerDir(paths.certsDir, ownerKey),
      leaf,
      provide: (effect) =>
        effect.pipe(
          Effect.provideService(PathsService, paths),
          Effect.provideService(
            CertificateAuthorityResolver,
            CertificateAuthorityResolver.of({ resolve: Effect.succeed(unavailableCa) }),
          ),
        ),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const targetOf = (appPlan: AppPlan) => ({
  plan: appPlan,
  root: appPlan.root,
  app: { kind: "user" as const, id: appPlan.id, root: appPlan.root },
});

test("start fails with the CA's own error before the provider applies anything", async () => {
  await withCertificates(async ({ certsPlan, provide }) => {
    const applied: AppPlan[] = [];
    const harness = makeHarness({
      plannedApp: certsPlan,
      onApply: (appPlan) => {
        applied.push(appPlan);
      },
    });
    const error = await Effect.runPromise(
      Effect.flip(provide(startApp({}, targetOf(certsPlan))).pipe(Effect.provide(harness.layer))),
    );
    expect(error).toBeInstanceOf(CaError);
    expect(error).toMatchObject({
      _tag: "CaError",
      caId: notInstalled.caId,
      cause: notInstalled,
      remediation: notInstalled.remediation,
    });
    expect(applied).toEqual([]);
  });
});

test.each(["stop", "destroy"] as const)("%s succeeds while the CA cannot issue", async (operation) => {
  await withCertificates(async ({ certsPlan, provide }) => {
    const harness = makeHarness({ plannedApp: certsPlan, appliedPlans: [certsPlan] });
    const target = targetOf(certsPlan);
    const outcome =
      operation === "stop"
        ? (await Effect.runPromise(provide(stopAppWithPlan({}, target)).pipe(Effect.provide(harness.layer))))
            .result.outcome
        : (
            await Effect.runPromise(
              provide(destroyAppForTarget({}, target)).pipe(Effect.provide(harness.layer)),
            )
          ).outcome;
    expect(outcome).toBe(operation === "stop" ? "stopped" : "destroyed");
  });
});

test("destroy removes the owner's leaf material only after teardown succeeded", async () => {
  await withCertificates(async ({ certsPlan, ownerDir, leaf, provide }) => {
    // Given: leaf material and a provider whose teardown fails
    await Bun.write(leaf.certPath, "certificate\n");
    await writeFile(leaf.keyPath, "key\n");
    const failing = makeHarness({
      plannedApp: certsPlan,
      appliedPlans: [certsPlan],
      destroyEffect: Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "destroy",
          message: "destroy failed",
          remediation: "Retry.",
        }),
      ),
    });
    // When
    await Effect.runPromise(
      Effect.flip(provide(destroyAppForTarget({}, targetOf(certsPlan))).pipe(Effect.provide(failing.layer))),
    );
    // Then: the failed teardown keeps the material
    expect((await readdir(ownerDir)).sort()).toEqual(
      [basename(leaf.certPath), basename(leaf.keyPath)].sort(),
    );

    // When: teardown succeeds; Then: the owner's directory is gone
    const succeeding = makeHarness({ plannedApp: certsPlan, appliedPlans: [certsPlan] });
    await Effect.runPromise(
      provide(destroyAppForTarget({}, targetOf(certsPlan))).pipe(Effect.provide(succeeding.layer)),
    );
    expect(await Bun.file(leaf.certPath).exists()).toBe(false);
    await expect(stat(ownerDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test.each([
  ["provider-scoped", true],
  ["unscoped", false],
] as const)("%s destroy of an applied app and the owner's leaf material", async (_label, scoped) => {
  await withCertificates(async ({ certsPlan, leaf, provide }) => {
    // Given: leaf material shared by every provider realization of the app
    await Bun.write(leaf.certPath, "certificate\n");
    const harness = makeHarness({ plannedApp: certsPlan, appliedPlans: [certsPlan] });
    // When: teardown succeeds
    const result = await Effect.runPromise(
      provide(destroyApp(scoped ? { providerId: certsPlan.provider } : {}, targetOf(certsPlan))).pipe(
        Effect.provide(harness.layer),
      ),
    );
    // Then: only an unscoped destroy removes the owner's directory
    expect(result.outcome).toBe("destroyed");
    expect(await Bun.file(leaf.certPath).exists()).toBe(scoped);
  });
});

test("stop keeps the owner's leaf material", async () => {
  await withCertificates(async ({ certsPlan, ownerDir, leaf, provide }) => {
    await Bun.write(leaf.certPath, "certificate\n");
    const harness = makeHarness({ plannedApp: certsPlan, appliedPlans: [certsPlan] });
    await Effect.runPromise(
      provide(stopAppWithPlan({}, targetOf(certsPlan))).pipe(Effect.provide(harness.layer)),
    );
    expect(await readdir(ownerDir)).toEqual([basename(leaf.certPath)]);
  });
});
