import { describe, expect, test } from "bun:test";
import { Effect, Exit, Redacted } from "effect";

import {
  ContractFailure,
  TEST_CERTIFICATES,
  TestCertificateAuthority,
  makeTestCertificateAuthority,
  runCaContract,
} from "@lando/sdk/test";

describe("CertificateAuthority contract", () => {
  test("TestCertificateAuthority satisfies runCaContract", async () => {
    const exit = await Effect.runPromiseExit(runCaContract(TestCertificateAuthority));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("TestCertificateAuthority has the expected id", () => {
    expect(TestCertificateAuthority.id).toBe("test");
  });

  test("ContractFailure is exported from the SDK test module", () => {
    expect(ContractFailure).toBeDefined();
  });

  test("makeTestCertificateAuthority records setup and issueCert calls", async () => {
    const ca = makeTestCertificateAuthority();

    await Effect.runPromise(ca.setup({ force: false }));
    await Effect.runPromise(ca.issueCert({ cn: "myapp.lndo.site", sans: ["*.myapp.lndo.site"] }));

    expect(ca.calls).toHaveLength(2);
    expect(ca.calls[0]?.op).toBe("setup");
    expect(ca.calls[1]?.op).toBe("issueCert");
  });

  test("makeTestCertificateAuthority issueCert returns its fixed material under the root it reports", async () => {
    const ca = makeTestCertificateAuthority();
    const result = await Effect.runPromise(ca.issueCert({ cn: "web.lndo.site", sans: ["*.web.lndo.site"] }));
    expect(result.certificate).toBe(TEST_CERTIFICATES.contract.certificate);
    expect(Redacted.value(result.privateKey)).toBe(TEST_CERTIFICATES.contract.privateKey);
    expect(result.root).toEqual(await Effect.runPromise(ca.root));
  });

  test("runCaContract fails an authority whose issued leaf is not signed by the root it reports", async () => {
    // Given: an authority that reports rootB while handing out a leaf rootA signed
    const ca = makeTestCertificateAuthority();
    const mismatched = {
      ...ca,
      root: Effect.succeed({ certificate: TEST_CERTIFICATES.rootB, trusted: true }),
      issueCert: (spec: Parameters<typeof ca.issueCert>[0]) =>
        ca.issueCert(spec).pipe(
          Effect.map((issued) => ({
            ...issued,
            root: { certificate: TEST_CERTIFICATES.rootB, trusted: true },
          })),
        ),
    };
    // When
    const exit = await Effect.runPromiseExit(runCaContract(mismatched));
    // Then: the only broken promise is the signature check, so the suite fails on it
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toBeInstanceOf(
        ContractFailure,
      );
    }
  });

  test("runCaContract fails an authority whose root disagrees with the root it signs with", async () => {
    // Given: an authority that signs with rootA and says so on each issuance, but reports rootB as its root
    const drifted = {
      ...makeTestCertificateAuthority(),
      root: Effect.succeed({ certificate: TEST_CERTIFICATES.rootB, trusted: true }),
    };
    // When
    const exit = await Effect.runPromiseExit(runCaContract(drifted));
    // Then: a consumer would reissue on every apply, so the suite fails
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
      expect(failure).toBeInstanceOf(ContractFailure);
      expect(failure).toHaveProperty(
        "assertion",
        "the issued pair verifies against the root the authority reports afterwards",
      );
    }
  });
});
