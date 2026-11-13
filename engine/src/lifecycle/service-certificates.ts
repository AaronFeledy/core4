/**
 * Apply-time preparation of generated service leaf certificates.
 *
 * Planning only records where a service's leaf pair lives and which authority
 * issues it. Before a plan reaches the provider, this module keeps the pair at
 * those Lando-owned paths current. A pair that covers the requested names, is
 * outside the renewal margin, matches its key, and was signed by the
 * authority's current root is reused without asking the authority; otherwise
 * the authority issues a fresh pair, which is checked and then published. The
 * certificate digest is stamped onto both binds as `sourceIdentity`. The
 * create fingerprint covers that identity, so changed material recreates the
 * service and unchanged material never does.
 *
 * Preparation returns the stamped plan and a proof bound to the owner key and
 * to each service's certificate request and bind sources. The activation
 * applier takes that proof and stamps the plan it applies, so no apply can
 * carry an identity that was not prepared for it.
 *
 * Publication is atomic per file. An incomplete pair is rejected and repaired
 * before the next Lando apply; a container the runtime starts on its own
 * before then may fail to load its certificate.
 */
import { chmod, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { certificatePairIsCurrent } from "@lando/sdk/certificates";
import { mapFailures } from "@lando/sdk/command-result";
import { sha256Hex } from "@lando/sdk/digest";
import { CaError, isErrnoCode } from "@lando/sdk/errors";
import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import type { CertificateAuthorityShape } from "@lando/sdk/services";
import { writeFileAtomic } from "@lando/state-store/atomic";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Clock, Effect, Option, Redacted } from "effect";

import {
  CertificateAuthorityResolver,
  type CertificateAuthorityResolverShape,
} from "../plugins/certificate-authority-resolver.ts";
import { taggedErrorRemediation } from "../providers/managed.ts";
import { routeOwnerFromPlan } from "./route-owner.ts";
import { resolveCertsDir, serviceCertificatePaths } from "./service-certificate-paths.ts";

/** Reissue this long before expiry so a running service never reaches an expired leaf. */
const RENEWAL_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

type CertificateAuthorityResolutionError = Effect.Error<CertificateAuthorityResolverShape["resolve"]>;

const readText = (path: string) =>
  Effect.tryPromise(async () => {
    try {
      return await readFile(path, "utf8");
    } catch (cause) {
      // No pair: the write that follows reports a path it cannot create.
      if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR")) return undefined;
      throw cause;
    }
  });

const hasBindFrom = (service: ServicePlan, source: string): boolean =>
  service.mounts.some((mount) => mount.type === "bind" && mount.source === source);

declare const preparedCertificates: unique symbol;

type PreparedCertificate = {
  readonly certs: NonNullable<ServicePlan["certs"]>;
  readonly certPath: string;
  readonly keyPath: string;
  readonly identity: string;
};

export interface PreparedCertificates {
  readonly [preparedCertificates]: true;
  readonly ownerKey: string;
  readonly services: ReadonlyMap<string, PreparedCertificate>;
}

/** The only constructor of the proof; called once preparation has made every pair current. */
const certificateProof = (
  ownerKey: string,
  services: ReadonlyMap<string, PreparedCertificate>,
): PreparedCertificates => ({ ownerKey, services }) as PreparedCertificates;

/** Checks a plan against the proof, then writes the prepared identity onto each certificate bind. */
export const stampPreparedCertificates = Effect.fn("ServiceCertificates.stamp")(function* (
  plan: AppPlan,
  certificates: PreparedCertificates,
): Effect.fn.Return<AppPlan, CaError> {
  const sameOwner = routeOwnerFromPlan(plan).ownerKey === certificates.ownerKey;
  const services = { ...plan.services };
  for (const service of Object.values(plan.services)) {
    const certs = service.certs;
    if (certs === undefined) continue;
    const prepared = certificates.services.get(service.name);
    if (
      !sameOwner ||
      prepared === undefined ||
      certs.caId !== prepared.certs.caId ||
      certs.cn !== prepared.certs.cn ||
      new Set(certs.sans).size !== new Set(prepared.certs.sans).size ||
      certs.sans.some((name) => !prepared.certs.sans.includes(name)) ||
      !hasBindFrom(service, prepared.certPath) ||
      !hasBindFrom(service, prepared.keyPath)
    ) {
      return yield* Effect.fail(
        new CaError({
          caId: certs.caId,
          message: `Prepared certificates do not match service ${service.name}.`,
          remediation: "Re-run the command so Lando plans and prepares the app again.",
        }),
      );
    }
    services[service.name] = {
      ...service,
      mounts: service.mounts.map((mount) =>
        mount.type === "bind" && (mount.source === prepared.certPath || mount.source === prepared.keyPath)
          ? { ...mount, sourceIdentity: prepared.identity }
          : mount,
      ),
    };
  }
  return { ...plan, services };
});

export const prepareServiceCertificates = Effect.fn("ServiceCertificates.prepare")(function* (
  plan: AppPlan,
): Effect.fn.Return<{ readonly plan: AppPlan; readonly certificates: PreparedCertificates }, CaError> {
  const ownerKey = routeOwnerFromPlan(plan).ownerKey;
  const prepared = new Map<string, PreparedCertificate>();
  const withCerts = Object.values(plan.services).flatMap((service) =>
    service.certs === undefined ? [] : [{ service, certs: service.certs, name: service.name }],
  );
  if (withCerts.length === 0) return { plan, certificates: certificateProof(ownerKey, prepared) };
  const certsDir = yield* resolveCertsDir();
  const generated = withCerts.map((entry) => ({
    ...entry,
    paths: serviceCertificatePaths(certsDir, ownerKey, entry.name),
  }));
  // A plan made against another certificate directory (stale cache, other data root) mounts
  // different files; writing here would leave the container without the material.
  for (const { service, certs, name, paths } of generated) {
    if (hasBindFrom(service, paths.certPath) && hasBindFrom(service, paths.keyPath)) continue;
    return yield* Effect.fail(
      new CaError({
        message: `Service ${name} has planned certificate paths that do not match this runtime's certificate directory ${certsDir}.`,
        caId: certs.caId,
        remediation:
          "Re-run the command so Lando plans the app again. For a cached scratch app, acquire it again.",
      }),
    );
  }
  const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
  const privateFiles = yield* Effect.serviceOption(PrivateFileAccessService);
  const resolve: Effect.Effect<CertificateAuthorityShape, CaError | CertificateAuthorityResolutionError> =
    Option.isSome(resolver)
      ? resolver.value.resolve
      : Effect.fail(
          new CaError({
            message: "This runtime has no certificate authority resolver.",
            caId: "unresolved",
            remediation: "Run the command through the standard Lando runtime, which selects the active CA.",
          }),
        );
  const authority = yield* Effect.cached(resolve);
  let root: string | undefined;
  for (const { service, certs, name, paths } of generated) {
    const dir = dirname(paths.certPath);
    const ca: CertificateAuthorityShape = yield* authority.pipe(
      mapFailures(
        (cause) =>
          new CaError({
            message: `Unable to resolve the certificate authority for service ${name}.`,
            caId: certs.caId,
            remediation:
              taggedErrorRemediation(cause) ??
              "Install a certificate-authority plugin with `lando setup` and select it as the active CA, then re-run.",
            cause,
          }),
      ),
    );
    if (ca.id !== certs.caId) {
      return yield* Effect.fail(
        new CaError({
          message: `Service ${name} was planned for certificate authority ${certs.caId}, but the active certificate authority is ${ca.id}.`,
          caId: ca.id,
          remediation: `Keep exactly one certificate authority plugin enabled, then retry. Use certs: false on ${name} to run it without a generated certificate.`,
        }),
      );
    }
    const issueError = (cause: CaError) =>
      new CaError({
        message: `Unable to issue the certificate for service ${name}.`,
        caId: cause.caId,
        remediation: cause.remediation,
        cause,
      });
    // Every service in this call is judged against one reading of the root.
    root ??= (yield* ca.root.pipe(mapFailures(issueError))).certificate;
    const names = [...new Set([...certs.sans, certs.cn])];
    const [existingCertificate, existingKey] = yield* Effect.all([
      readText(paths.certPath),
      readText(paths.keyPath),
    ]).pipe(
      mapFailures(
        (cause) =>
          new CaError({
            message: `Unable to read the certificate for service ${name} from ${dir}.`,
            caId: ca.id,
            remediation: `Make sure ${dir} is readable by the current user, then retry.`,
            cause,
          }),
      ),
    );
    const isCurrent = (certificate: string, privateKey: string, againstRoot: string, now: number) =>
      certificatePairIsCurrent(
        { certificate, privateKey },
        { names, now, renewalMarginMs: RENEWAL_MARGIN_MS, root: againstRoot },
      );
    let certificate: string;
    if (
      existingCertificate !== undefined &&
      existingKey !== undefined &&
      isCurrent(existingCertificate, existingKey, root, yield* Clock.currentTimeMillis)
    ) {
      certificate = existingCertificate;
    } else {
      const issued = yield* ca.issueCert({ cn: certs.cn, sans: certs.sans }).pipe(mapFailures(issueError));
      const privateKey = Redacted.value(issued.privateKey);
      // Read the clock again: a fresh leaf's notBefore is later than any timestamp taken before issuance.
      if (
        !isCurrent(issued.certificate, privateKey, issued.root.certificate, yield* Clock.currentTimeMillis)
      ) {
        return yield* Effect.fail(
          new CaError({
            message: `Certificate authority ${ca.id} issued a certificate for service ${name} that Lando cannot use: it does not cover the requested names, does not match its private key, is outside its validity window, or is not signed by the root the authority reports.`,
            caId: ca.id,
            remediation: `Repair or reinstall the ${ca.id} certificate authority with \`lando setup\`, then retry. If it keeps happening, report it to the plugin that provides the ${ca.id} certificate authority.`,
          }),
        );
      }
      const write = (target: string, content: string, mode: number) =>
        Effect.tryPromise(() =>
          writeFileAtomic(target, content, {
            mode,
            ...(mode === 0o600 && Option.isSome(privateFiles)
              ? { privateFileAccess: privateFiles.value.enforce }
              : { ownerOnly: "best-effort" as const }),
          }),
        );
      // Key first, then certificate; an interrupt waits for both. A pair a failed write leaves
      // mixed no longer verifies, so the next apply replaces it.
      yield* Effect.gen(function* () {
        yield* Effect.tryPromise(async () => {
          await mkdir(dir, { recursive: true, mode: 0o700 });
          await chmod(dir, 0o700);
        });
        yield* write(paths.keyPath, privateKey, 0o600);
        yield* write(paths.certPath, issued.certificate, 0o644);
      }).pipe(
        Effect.uninterruptible,
        mapFailures(
          (cause) =>
            new CaError({
              message: `Unable to write the certificate for service ${name} to ${dir}.`,
              caId: ca.id,
              remediation: `Make sure ${dir} is writable by the current user, then retry.`,
              cause,
            }),
        ),
      );
      certificate = issued.certificate;
    }
    prepared.set(service.name, {
      certs: { ...certs, sans: [...certs.sans] },
      ...paths,
      identity: sha256Hex(certificate),
    });
  }
  const certificates = certificateProof(ownerKey, prepared);
  return { plan: yield* stampPreparedCertificates(plan, certificates), certificates };
});
