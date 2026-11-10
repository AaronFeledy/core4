import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { CREATE_CONFIG_LABEL } from "@lando/container-runtime/create-fingerprint";
import { commonContainerLabels } from "@lando/container-runtime/plan";
import { makeLandoPaths } from "@lando/paths";
import type { CertificatePair } from "@lando/sdk/certificates";
import { sha256Hex } from "@lando/sdk/digest";
import { CaError } from "@lando/sdk/errors";
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
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { routeOwnerFromPlan } from "../../src/lifecycle/route-owner.ts";
import {
  serviceCertificatePaths,
  serviceCertificatesOwnerDir,
} from "../../src/lifecycle/service-certificate-paths.ts";
import { prepareServiceCertificates } from "../../src/lifecycle/service-certificates.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SERVICE_NAMES = ["web", "web.app.internal", "localhost", "127.0.0.1"];
const metadata = {
  resolvedAt: DateTime.makeUnsafe(0),
  source: "service-certificates",
  runtime: 4 as const,
};
const provider = ProviderId.make("podman");

const service = (name: string): ServicePlan => ({
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

const basePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
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

const leafBind = (source: string, target: string) => ({
  type: "bind" as const,
  source,
  target: PortablePath.make(target),
  readOnly: true,
  createHostPath: false,
  realization: "passthrough" as const,
  origin: "service" as const,
});

const planWithCertificate = (
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

const makeHarness = async () => {
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
        ? Effect.succeed({ certificate: authority.root })
        : Effect.fail(authority.rootFailure);
    }),
    issueCert: (spec) =>
      Effect.suspend(() => {
        issued.push(spec);
        if (authority.issueFailure !== undefined) return Effect.fail(authority.issueFailure);
        return Effect.succeed({
          certificate: authority.issue.certificate,
          privateKey: Redacted.make(authority.issue.privateKey),
          root: { certificate: authority.issuedRoot ?? authority.root },
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
    prepare: (plan: AppPlan) => Effect.runPromise(run(plan)),
    prepareExit: (plan: AppPlan) => Effect.runPromiseExit(run(plan)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const withHarness = async (body: (harness: Awaited<ReturnType<typeof makeHarness>>) => Promise<void>) => {
  const harness = await makeHarness();
  try {
    await body(harness);
  } finally {
    await harness.cleanup();
  }
};

const fingerprint = (plan: AppPlan, name = "web") => {
  const target = plan.services[ServiceName.make(name)];
  if (target === undefined) throw new Error(`missing service ${name}`);
  return commonContainerLabels(plan, target)[CREATE_CONFIG_LABEL];
};

const sourceIdentities = (plan: AppPlan, name: string) =>
  (plan.services[ServiceName.make(name)]?.mounts ?? []).map((mount) =>
    mount.type === "bind" ? mount.sourceIdentity : undefined,
  );

const caFailure = (exit: Exit.Exit<AppPlan, CaError>): CaError => {
  if (Exit.isSuccess(exit)) throw new Error("expected certificate preparation to fail");
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
  if (!(error instanceof CaError)) throw new Error("expected a CaError");
  return error;
};

const readPair = async (leaf: { readonly certPath: string; readonly keyPath: string }) => ({
  certificate: await readFile(leaf.certPath, "utf8"),
  privateKey: await readFile(leaf.keyPath, "utf8"),
});

/** Content plus the identity of the file at each path, so any rewrite shows up. */
const fileState = async (leaf: { readonly certPath: string; readonly keyPath: string }) =>
  Promise.all(
    [leaf.certPath, leaf.keyPath].map(async (path) => {
      const info = await stat(path);
      return { content: await readFile(path, "utf8"), ino: info.ino, mtimeMs: info.mtimeMs };
    }),
  );

test("first issuance publishes the pair with owner-only key and stamps both binds", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // When
    const prepared = await harness.prepare(plan);
    // Then
    expect(await readPair(leaf)).toEqual(TEST_CERTIFICATES.service);
    expect((await stat(leaf.keyPath)).mode & 0o777).toBe(0o600);
    expect((await stat(leaf.certPath)).mode & 0o777).toBe(0o644);
    expect((await stat(dirname(leaf.certPath))).mode & 0o777).toBe(0o700);
    const identity = sha256Hex(TEST_CERTIFICATES.service.certificate);
    expect(sourceIdentities(prepared, "web")).toEqual([identity, identity]);
    expect(sourceIdentities(prepared, "custom")).toEqual([undefined]);
    expect(harness.issued).toEqual([{ cn: "web.app.internal", sans: SERVICE_NAMES }]);
  });
});

test("a current pair is reused without issuing or writing, and keeps the create fingerprint", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // Given: one preparation already applied
    const first = await harness.prepare(plan);
    const before = await fileState(leaf);
    // When: the next apply prepares the same plan, even with a different pair on offer
    harness.authority.issue = TEST_CERTIFICATES.serviceRenewed;
    const second = await harness.prepare(plan);
    // Then: no issuance, no write, and the provider sees an identical create configuration
    expect(harness.counts().issues).toBe(1);
    expect(await fileState(leaf)).toEqual(before);
    expect(fingerprint(second)).toBe(fingerprint(first));
    expect(fingerprint(first)).not.toBe(fingerprint(plan));
  });
});

test("a certificate that also names something no longer requested is reused", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // Given: the published pair carries one more name than the plan requests
    await mkdir(dirname(leaf.certPath), { recursive: true });
    await writeFile(leaf.certPath, TEST_CERTIFICATES.serviceExtraName.certificate);
    await writeFile(leaf.keyPath, TEST_CERTIFICATES.serviceExtraName.privateKey);
    // When
    const prepared = await harness.prepare(plan);
    // Then
    expect(harness.counts().issues).toBe(0);
    expect(sourceIdentities(prepared, "web")[0]).toBe(
      sha256Hex(TEST_CERTIFICATES.serviceExtraName.certificate),
    );
  });
});

describe("reissues and recreates when the published pair is not current", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly change: (input: {
      readonly harness: Awaited<ReturnType<typeof makeHarness>>;
      readonly leaf: { readonly certPath: string; readonly keyPath: string };
    }) => Promise<{ readonly sans?: ReadonlyArray<string> } | undefined>;
    readonly renewed: CertificatePair;
  }> = [
    {
      name: "a requested name is not covered",
      change: async () => ({ sans: [...SERVICE_NAMES, "web.app.lndo.site"] }),
      renewed: TEST_CERTIFICATES.serviceExtraName,
    },
    {
      name: "the authority's root changed",
      change: async ({ harness }) => {
        harness.authority.root = TEST_CERTIFICATES.rootB;
        return undefined;
      },
      renewed: TEST_CERTIFICATES.serviceFromRootB,
    },
    {
      name: "the key on disk does not match the certificate",
      change: async ({ leaf }) => {
        await writeFile(leaf.keyPath, TEST_CERTIFICATES.serviceRenewed.privateKey);
        return undefined;
      },
      renewed: TEST_CERTIFICATES.serviceRenewed,
    },
    {
      name: "the certificate is missing",
      change: async ({ leaf }) => {
        await rm(leaf.certPath);
        return undefined;
      },
      renewed: TEST_CERTIFICATES.serviceRenewed,
    },
    {
      name: "the key is missing",
      change: async ({ leaf }) => {
        await rm(leaf.keyPath);
        return undefined;
      },
      renewed: TEST_CERTIFICATES.serviceRenewed,
    },
  ];

  test.each(cases)("$name", async ({ change, renewed }) => {
    await withHarness(async (harness) => {
      const { plan, leaf } = planWithCertificate(harness.certsDir);
      const first = await harness.prepare(plan);
      // Given
      const changed = await change({ harness, leaf });
      harness.authority.issue = renewed;
      const next = changed?.sans === undefined ? plan : planWithCertificate(harness.certsDir, changed).plan;
      // When
      const prepared = await harness.prepare(next);
      // Then: the authority issued once more, the new pair is published, and the service is recreated
      expect(harness.counts().issues).toBe(2);
      expect(await readPair(leaf)).toEqual(renewed);
      expect(sourceIdentities(prepared, "web")[0]).toBe(sha256Hex(renewed.certificate));
      expect(fingerprint(prepared)).not.toBe(fingerprint(first));
    });
  });
});

test("renews 30 days before expiry and not earlier", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // Given: a published one-year leaf
    harness.authority.issue = TEST_CERTIFICATES.serviceOneYear;
    await harness.prepare(plan);
    harness.authority.issue = TEST_CERTIFICATES.service;
    // When: the clock reaches one millisecond before the 30-day margin
    harness.clock.now = TEST_CERTIFICATES.oneYearValidTo - 30 * DAY_MS - 1;
    await harness.prepare(plan);
    // Then: still reused
    expect(harness.counts().issues).toBe(1);
    // When: the clock enters the margin
    harness.clock.now = TEST_CERTIFICATES.oneYearValidTo - 30 * DAY_MS;
    await harness.prepare(plan);
    // Then: renewed
    expect(harness.counts().issues).toBe(2);
    expect(await readPair(leaf)).toEqual(TEST_CERTIFICATES.service);
  });
});

describe("refuses material the authority issued that is not current for the request", () => {
  test.each([
    {
      name: "it does not cover the requested names",
      authority: { issue: TEST_CERTIFICATES.contract },
    },
    {
      name: "a root other than the one it reports signed it",
      authority: { issue: TEST_CERTIFICATES.serviceFromRootB },
    },
    {
      name: "the root it reports for the issuance did not sign it",
      authority: { issue: TEST_CERTIFICATES.service, issuedRoot: TEST_CERTIFICATES.rootB },
    },
  ])("$name", async ({ authority }) => {
    await withHarness(async (harness) => {
      const { plan, leaf } = planWithCertificate(harness.certsDir);
      // Given: a published pair whose key was replaced, so the next apply must issue
      await harness.prepare(plan);
      await writeFile(leaf.keyPath, TEST_CERTIFICATES.serviceRenewed.privateKey);
      const before = await fileState(leaf);
      Object.assign(harness.authority, authority);
      // When
      const error = caFailure(await harness.prepareExit(plan));
      // Then: nothing is published
      expect(error).toMatchObject({ _tag: "CaError", caId: "fake" });
      expect(error.remediation).toContain("lando setup");
      expect(await fileState(leaf)).toEqual(before);
    });
  });
});

test.each(["root", "issueCert"] as const)(
  "a failing %s maps to CaError with the authority's remediation",
  async (operation) => {
    await withHarness(async (harness) => {
      const { plan, leaf } = planWithCertificate(harness.certsDir);
      const cause = new CaError({
        message: "mkcert v1.4.4 is not installed at /bin/mkcert.",
        caId: "fake",
        remediation: "Run `lando setup` to download mkcert and install the local CA.",
      });
      if (operation === "root") harness.authority.rootFailure = cause;
      else harness.authority.issueFailure = cause;
      const error = caFailure(await harness.prepareExit(plan));
      expect(error).toMatchObject({ _tag: "CaError", caId: "fake", remediation: cause.remediation });
      expect(error.cause).toBe(cause);
      expect(harness.counts().issues).toBe(operation === "root" ? 0 : 1);
      await expect(stat(leaf.certPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);

test("reads the root once per call for every service", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir);
    const web = plan.services[ServiceName.make("web")];
    if (web?.certs === undefined) throw new Error("missing web service");
    const api = serviceCertificatePaths(harness.certsDir, routeOwnerFromPlan(plan).ownerKey, "api");
    const twoServices = basePlan([
      web,
      {
        ...service("api"),
        certs: web.certs,
        mounts: [leafBind(api.certPath, "/etc/api.crt"), leafBind(api.keyPath, "/etc/api.key")],
      },
    ]);
    await harness.prepare(twoServices);
    expect(harness.counts()).toEqual({ resolves: 1, rootReads: 1, issues: 2 });
  });
});

test("services without a generated certificate never resolve the certificate authority", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir);
    const custom = plan.services[ServiceName.make("custom")];
    if (custom === undefined) throw new Error("missing custom service");
    const withoutGenerated = basePlan([custom, service("plain")]);
    const prepared = await harness.prepare(withoutGenerated);
    expect(prepared).toEqual(withoutGenerated);
    expect(harness.counts()).toEqual({ resolves: 0, rootReads: 0, issues: 0 });
  });
});

test("rejects a plan whose certificate authority is not the active one", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir, { caId: "mkcert" });
    const error = caFailure(await harness.prepareExit(plan));
    expect(error).toMatchObject({ _tag: "CaError", caId: "fake" });
    expect(harness.counts()).toEqual({ resolves: 1, rootReads: 0, issues: 0 });
  });
});

test("fails without a certificate authority resolver", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    const exit = await Effect.runPromiseExit(
      prepareServiceCertificates(plan).pipe(Effect.provideService(PathsService, harness.paths)),
    );
    expect(caFailure(exit)).toMatchObject({
      _tag: "CaError",
      cause: { _tag: "CaError", caId: "unresolved" },
    });
    await expect(stat(leaf.certPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("reports a filesystem remediation when the owned paths cannot be written", async () => {
  await withHarness(async (harness) => {
    const { plan } = planWithCertificate(harness.certsDir);
    // Given: the certs directory is a regular file, so no owner directory can be created below it
    await mkdir(join(harness.certsDir, ".."), { recursive: true });
    await writeFile(harness.certsDir, "not a directory\n");
    const error = caFailure(await harness.prepareExit(plan));
    expect(error).toMatchObject({ _tag: "CaError", caId: "fake" });
    expect(error.remediation).toContain("is writable by the current user");
  });
});

test("a certificate write that fails after the key was replaced leaves a pair the next apply repairs", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // Given: a published pair, and a renewal during which the certificate path stops being replaceable
    await harness.prepare(plan);
    harness.authority.root = TEST_CERTIFICATES.rootB;
    harness.authority.issue = TEST_CERTIFICATES.serviceFromRootB;
    const obstruct = PrivateFileAccessService.of({
      enforce: async () => {
        await rm(leaf.certPath);
        await mkdir(join(leaf.certPath, "obstruction"), { recursive: true });
      },
      verify: async () => {},
    });
    // When
    const error = caFailure(
      await Effect.runPromiseExit(
        harness.run(plan).pipe(Effect.provideService(PrivateFileAccessService, obstruct)),
      ),
    );
    // Then: the new key is in place and the certificate is not
    expect(error).toMatchObject({ _tag: "CaError", caId: "fake" });
    expect(await readFile(leaf.keyPath, "utf8")).toBe(TEST_CERTIFICATES.serviceFromRootB.privateKey);
    // Given: the old certificate back beside the new key, a mixed pair
    await rm(leaf.certPath, { recursive: true });
    await writeFile(leaf.certPath, TEST_CERTIFICATES.service.certificate);
    // When: the next apply runs
    await harness.prepare(plan);
    // Then: the mixed pair is replaced by a whole one
    expect(harness.counts().issues).toBe(3);
    expect(await readPair(leaf)).toEqual(TEST_CERTIFICATES.serviceFromRootB);
  });
});

test("rejects a plan whose certificate binds do not match this runtime's certificate directory", async () => {
  await withHarness(async (harness) => {
    // Given: a plan recorded against another data root's certificate directory
    const { plan } = planWithCertificate(join(harness.root, "other-data", "certs"));
    // When
    const error = caFailure(await harness.prepareExit(plan));
    // Then: it fails before resolving the authority or writing any material
    expect(error).toMatchObject({ _tag: "CaError", caId: "fake" });
    expect(error.remediation).toContain("Re-run the command");
    expect(harness.counts()).toEqual({ resolves: 0, rootReads: 0, issues: 0 });
    await expect(stat(harness.certsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("service names that differ only by case get distinct leaf files, and a name always gets the same files", () => {
  const lower = serviceCertificatePaths("/certs", "owner", "web");
  const upper = serviceCertificatePaths("/certs", "owner", "WEB");
  // Case-insensitive host filesystems (Windows, macOS) compare names after folding case.
  expect(upper.certPath.toLowerCase()).not.toBe(lower.certPath.toLowerCase());
  expect(upper.keyPath.toLowerCase()).not.toBe(lower.keyPath.toLowerCase());
  expect(serviceCertificatePaths("/certs", "owner", "web")).toEqual(lower);
  expect(serviceCertificatePaths("/certs", "owner", "WEB")).toEqual(upper);
});

test.each(["aux", "con", "nul", "com1"])("service %s does not get a Windows reserved device name", (name) => {
  const { certPath, keyPath } = serviceCertificatePaths("/certs", "owner", name);
  for (const path of [certPath, keyPath]) {
    const stem = basename(path).split(".")[0];
    expect(stem).not.toMatch(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i);
  }
});

test("names outside the safe character set stay bounded plain files inside the owner directory", () => {
  const ownerDir = serviceCertificatesOwnerDir("/certs", "owner");
  for (const name of [
    "../escape",
    "a/b\\c",
    "..",
    'we b:*?<>|"',
    "caf\u00e9.d\u00e9j\u00e0",
    "x".repeat(300),
  ]) {
    const { certPath, keyPath } = serviceCertificatePaths("/certs", "owner", name);
    for (const path of [certPath, keyPath]) {
      expect(dirname(path)).toBe(ownerDir);
      expect(basename(path)).toMatch(/^[a-z0-9_-]{1,61}\.(crt|key)$/);
    }
  }
});

test("an apply interrupted while the pair is being published still publishes the whole pair", async () => {
  await withHarness(async (harness) => {
    const { plan, leaf } = planWithCertificate(harness.certsDir);
    // Given: a published pair, and an authority whose root rotated, so the next apply renews
    await harness.prepare(plan);
    harness.authority.root = TEST_CERTIFICATES.rootB;
    harness.authority.issue = TEST_CERTIFICATES.serviceFromRootB;
    // The private-file check runs on the new key's temp file, so the interrupt lands mid-publication.
    const keyWriting = Promise.withResolvers<void>();
    const releaseKey = Promise.withResolvers<void>();
    const privateFiles = PrivateFileAccessService.of({
      enforce: async () => {
        keyWriting.resolve();
        await releaseKey.promise;
      },
      verify: async () => {},
    });
    const fiber = Effect.runFork(
      harness.run(plan).pipe(Effect.provideService(PrivateFileAccessService, privateFiles)),
    );
    // When: the apply is interrupted while the new key is being written
    await keyWriting.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    releaseKey.resolve();
    await interrupted;
    // Then: the interrupt waited for publication, so the renewed key and certificate are both in place
    expect(await readPair(leaf)).toEqual(TEST_CERTIFICATES.serviceFromRootB);
  });
});
