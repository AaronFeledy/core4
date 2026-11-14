import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import type { CertificatePair } from "@lando/sdk/certificates";
import type { CaError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  CertificateName,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { CertificateAuthority, type CertificateSpec, PathsService } from "@lando/sdk/services";
import { TEST_CERTIFICATES } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import { serviceCertificatePaths } from "../../src/lifecycle/service-certificate-paths.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const SERVICE_NAMES = ["web", "web.app.internal", "localhost", "127.0.0.1"];
const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "service-certificates", runtime: 4 as const };
const provider = ProviderId.make("podman");

export const service = (name: string): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider,
  primary: name === "web",
  artifact: { kind: "ref", ref: "alpine:3" },
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});
export const basePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  valueModel: 1,
  id: AppId.make("certs-apply"),
  name: "certs-apply",
  slug: "certs-apply",
  root: AbsolutePath.make("/host/certs-apply"),
  provider,
  services: Object.fromEntries(services.map((entry) => [entry.name, entry])),
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});
export const leafBind = (source: string, target: string) => ({
  type: "bind" as const,
  source,
  target: PortablePath.make(target),
  readOnly: true,
  createHostPath: false,
  realization: "passthrough" as const,
  origin: "service" as const,
});
export const planWithCertificate = (
  certsDir: string,
  options: { readonly caId?: string; readonly sans?: ReadonlyArray<string> } = {},
) => {
  const draft = basePlan([]);
  const leaf = serviceCertificatePaths(certsDir, routeOwnerFromPlan(draft).ownerKey, "web");
  const plan = basePlan([
    {
      ...service("web"),
      certs: {
        cn: CertificateName.make("web.app.internal"),
        sans: (options.sans ?? SERVICE_NAMES).map((name) => CertificateName.make(name)),
        caId: options.caId ?? "fake",
      },
      mounts: [
        leafBind(leaf.certPath, "/etc/lando/certs/leaf/web.crt"),
        leafBind(leaf.keyPath, "/etc/lando/certs/leaf/web.key"),
      ],
    },
    {
      ...service("custom"),
      mounts: [leafBind("/host/certs-apply/custom.crt", "/etc/lando/certs/leaf/custom.crt")],
      extensions: { "@lando/core/certs": "custom" },
    },
  ]);
  return { plan, leaf };
};

/** The authority's current state; tests change it between applies. */
interface AuthorityState {
  root: string;
  issue: CertificatePair;
  /** The root issuance reports; defaults to `root`. */
  issuedRoot?: string;
  rootFailure?: CaError;
  issueFailure?: CaError;
}

export const makeHarness = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-service-certificates-"));
  const paths = makeLandoPaths({
    platform: "linux",
    home: root,
    env: {},
    userDataRoot: join(root, "data"),
    userCacheRoot: join(root, "cache"),
  });
  const authority: AuthorityState = { root: TEST_CERTIFICATES.rootA, issue: TEST_CERTIFICATES.service };
  const clock = { now: TEST_CERTIFICATES.validFrom + DAY_MS };
  const issued: CertificateSpec[] = [];
  let resolves = 0;
  let rootReads = 0;
  const ca = CertificateAuthority.of({
    id: "fake",
    setup: () => Effect.void,
    root: Effect.suspend(() => {
      rootReads += 1;
      return authority.rootFailure === undefined
        ? Effect.succeed({ certificate: authority.root, trusted: true })
        : Effect.fail(authority.rootFailure);
    }),
    issueCert: (spec) =>
      Effect.suspend(() => {
        issued.push(spec);
        if (authority.issueFailure !== undefined) return Effect.fail(authority.issueFailure);
        return Effect.succeed({
          certificate: authority.issue.certificate,
          privateKey: Redacted.make(authority.issue.privateKey),
          root: { certificate: authority.issuedRoot ?? authority.root, trusted: true },
        });
      }),
  });
  const layer = Layer.mergeAll(
    Layer.succeed(PathsService, paths),
    Layer.succeed(
      CertificateAuthorityResolver,
      CertificateAuthorityResolver.of({
        resolve: Effect.sync(() => {
          resolves += 1;
          return ca;
        }),
      }),
    ),
  );
  const run = (plan: AppPlan) =>
    TestClock.setTime(clock.now).pipe(
      Effect.andThen(prepareServiceCertificates(plan)),
      Effect.provide(layer),
      Effect.provide(TestClock.layer()),
    );
  return {
    root,
    paths,
    authority,
    clock,
    issued,
    certsDir: paths.certsDir,
    counts: () => ({ resolves, rootReads, issues: issued.length }),
    run,
    prepare: (plan: AppPlan) => Effect.runPromise(run(plan).pipe(Effect.map((prepared) => prepared.plan))),
    prepareExit: (plan: AppPlan) => Effect.runPromiseExit(run(plan)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

export const withHarness = async (
  body: (harness: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>,
) => {
  const harness = await makeHarness();
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
};
