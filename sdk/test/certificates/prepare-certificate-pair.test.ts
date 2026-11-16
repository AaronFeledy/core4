import { expect, test } from "bun:test";
import {
  CertificateMaterial,
  type CertificatePair,
  CertificatePairPreparation,
  LEAF_RENEWAL_MARGIN_MS,
  PreparedCertificatePair,
  prepareCertificatePair,
} from "@lando/sdk/certificates";
import { CaError } from "@lando/sdk/errors";
import { CertificateSpec } from "@lando/sdk/schema";
import type { IssuedCertificate } from "@lando/sdk/services";
import { TEST_CERTIFICATES as certs } from "@lando/sdk/test";
import { Effect, Redacted, Result, Schema } from "effect";
import { TestClock } from "effect/testing";

const spec = CertificateSpec.make({ cn: "web.app.internal", sans: ["web", "localhost", "127.0.0.1"] });
const material = (pair: CertificatePair) => ({
  certificate: pair.certificate,
  privateKey: Redacted.make(pair.privateKey),
});
const issued = (pair: CertificatePair = certs.service, root: string = certs.rootA): IssuedCertificate => ({
  ...material(pair),
  root: { certificate: root, trusted: false },
});
const run = <A, E>(effect: Effect.Effect<A, E>, now = certs.validFrom) =>
  Effect.runPromise(TestClock.setTime(now).pipe(Effect.andThen(effect), Effect.provide(TestClock.layer())));

test("reuses a complete current pair without issuance and keeps the private key redacted", async () => {
  let issues = 0;
  const result = await run(
    prepareCertificatePair(
      {
        id: "fake",
        issueCert: () =>
          Effect.sync(() => {
            issues += 1;
            return issued(certs.serviceRenewed);
          }),
      },
      {
        spec,
        root: certs.rootA,
        existing: material(certs.service),
        subject: "service web",
      },
    ),
  );
  expect(issues).toBe(0);
  expect(result).toMatchObject({
    source: "reused",
    certificate: certs.service.certificate,
    root: certs.rootA,
  });
  expect(Schema.is(PreparedCertificatePair)(result)).toBe(true);
  expect(Redacted.value(result.privateKey)).toBe(certs.service.privateKey);
  expect(JSON.stringify(result)).not.toContain(certs.service.privateKey);
  expect(Bun.inspect(result)).not.toContain(certs.service.privateKey);
  expect(Result.isFailure(Schema.encodeResult(Schema.toCodecJson(PreparedCertificatePair))(result))).toBe(
    true,
  );
});

test.each([
  ["missing", undefined],
  ["near expiry", certs.serviceOneYear],
  ["wrong name", certs.contract],
  ["old root", certs.serviceFromRootB],
  ["wrong key", { ...certs.service, privateKey: certs.serviceRenewed.privateKey }],
] as const)("replaces a %s pair once with complete issued material", async (_label, pair) => {
  let issues = 0;
  const result = await run(
    prepareCertificatePair(
      {
        id: "fake",
        issueCert: () =>
          Effect.sync(() => {
            issues += 1;
            return issued(certs.serviceRenewed);
          }),
      },
      {
        spec,
        root: certs.rootA,
        ...(pair === undefined ? {} : { existing: material(pair) }),
        subject: "service web",
      },
    ),
    certs.oneYearValidTo - 1,
  );
  expect(issues).toBe(1);
  expect(result).toMatchObject({
    source: "issued",
    certificate: certs.serviceRenewed.certificate,
    root: certs.rootA,
  });
  expect(Redacted.value(result.privateKey)).toBe(certs.serviceRenewed.privateKey);
});

test.each([
  ["wrong key", { ...issued(), privateKey: Redacted.make(certs.serviceRenewed.privateKey) }, certs.validFrom],
  ["wrong name", issued(certs.contract), certs.validFrom],
  ["wrong reported root", issued(certs.service, certs.rootB), certs.validFrom],
  ["malformed root", issued(certs.service, "invalid"), certs.validFrom],
  ["malformed leaf", issued({ ...certs.service, certificate: "invalid" }), certs.validFrom],
  ["future leaf", issued(), certs.validFrom - 1],
  ["near-expiry leaf", issued(certs.serviceOneYear), certs.oneYearValidTo - LEAF_RENEWAL_MARGIN_MS],
  ["expired leaf", issued(certs.serviceOneYear), certs.oneYearValidTo],
] as const)("refuses issuance with %s without exposing material", async (_label, response, at) => {
  let issues = 0;
  const error = await run(
    prepareCertificatePair(
      {
        id: "fake",
        issueCert: () =>
          Effect.sync(() => {
            issues += 1;
            return response;
          }),
      },
      {
        spec,
        root: certs.rootA,
        subject: "service web",
      },
    ).pipe(Effect.flip),
    at,
  );
  expect(issues).toBe(1);
  expect(error).toBeInstanceOf(CaError);
  expect(error).toMatchObject({ caId: "fake" });
  expect(error.message).toContain("service web");
  expect(error.remediation).toContain("lando setup");
  expect(JSON.stringify(error)).not.toContain("-----BEGIN");
});

test("validates the common name even when it is not repeated in SANs", async () => {
  const error = await run(
    prepareCertificatePair(
      { id: "fake", issueCert: () => Effect.succeed(issued()) },
      {
        spec: CertificateSpec.make({ cn: "uncovered.internal", sans: ["web"] }),
        root: certs.rootA,
        subject: "service web",
      },
    ).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(CaError);
});

test("public preparation schemas require complete material with redacted private keys", () => {
  const existing = material(certs.service);
  expect(Schema.is(CertificateMaterial)(existing)).toBe(true);
  expect(Schema.is(CertificateMaterial)(certs.service)).toBe(false);
  expect(Schema.is(CertificatePairPreparation)({ spec, root: certs.rootA, subject: "web", existing })).toBe(
    true,
  );
  expect(
    Schema.is(CertificatePairPreparation)({
      spec,
      root: certs.rootA,
      subject: "web",
      existing: { certificate: certs.service.certificate },
    }),
  ).toBe(false);
});

test("reads the clock after issuance and uses the root reported for that issuance", async () => {
  const result = await run(
    prepareCertificatePair(
      {
        id: "fake",
        issueCert: () =>
          TestClock.setTime(certs.validFrom).pipe(Effect.as(issued(certs.serviceFromRootB, certs.rootB))),
      },
      {
        spec,
        root: certs.rootA,
        subject: "service web",
      },
    ),
    certs.validFrom - 1,
  );
  expect(result).toMatchObject({
    source: "issued",
    certificate: certs.serviceFromRootB.certificate,
    root: certs.rootB,
  });
});

test("preserves authority failure identity and remediation", async () => {
  const cause = new CaError({ caId: "fake", message: "unavailable", remediation: "Install the authority." });
  const error = await run(
    prepareCertificatePair(
      { id: "fake", issueCert: () => Effect.fail(cause) },
      {
        spec,
        root: certs.rootA,
        subject: "service web",
      },
    ).pipe(Effect.flip),
  );
  expect(error).toBe(cause);
});
