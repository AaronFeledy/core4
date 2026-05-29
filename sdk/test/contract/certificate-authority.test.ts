import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  ContractFailure,
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

  test("makeTestCertificateAuthority issueCert returns cert paths", async () => {
    const ca = makeTestCertificateAuthority();
    const result = await Effect.runPromise(ca.issueCert({ cn: "web.lndo.site", sans: ["*.web.lndo.site"] }));
    expect(result.certPath).toContain("web.lndo.site");
    expect(result.keyPath).toContain("web.lndo.site");
    expect(result.caPath).toContain("ca");
  });
});
