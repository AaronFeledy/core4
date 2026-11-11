import { Clock, Effect, Redacted } from "effect";
import { certificatePairIsCurrent } from "../certificates/index.ts";
import { mapFailures } from "../command-result/failure.ts";

import { ContractFailure } from "./_shared.ts";
import { TEST_CERTIFICATES } from "./certificate-fixtures.ts";

import type {
  CaSetupOptions,
  CertificateAuthorityShape,
  CertificateSpec,
  IssuedCertificate,
} from "../services/index.ts";

const caContractFailure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `CertificateAuthority contract failed: ${assertion}`, assertion, details });

const requireCaContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(caContractFailure(assertion, details));

export const runCaContract = Effect.fnUntraced(function* (
  ca: CertificateAuthorityShape,
): Effect.fn.Return<void, ContractFailure> {
  yield* requireCaContract(typeof ca.id === "string" && ca.id.length > 0, "id is a non-empty string", ca.id);

  yield* ca.setup({ force: false }).pipe(mapFailures((d) => caContractFailure("setup resolves", d)));

  const root = yield* ca.root.pipe(mapFailures((d) => caContractFailure("root resolves", d)));
  yield* requireCaContract(
    root.certificate.includes("-----BEGIN CERTIFICATE-----"),
    "root is a non-empty PEM certificate",
  );
  yield* requireCaContract(typeof root.trusted === "boolean", "root reports whether the host trusts it");

  const spec = { cn: "test.lndo.site", sans: ["*.test.lndo.site"] };
  const issued = yield* ca
    .issueCert(spec)
    .pipe(mapFailures((d) => caContractFailure("issueCert resolves", d)));
  const privateKey = Redacted.value(issued.privateKey);
  yield* requireCaContract(
    issued.certificate.includes("-----BEGIN CERTIFICATE-----"),
    "issueCert returns a non-empty PEM certificate",
  );
  yield* requireCaContract(
    privateKey.includes("PRIVATE KEY-----"),
    "issueCert returns a non-empty PEM private key",
  );
  yield* requireCaContract(
    issued.root.certificate.includes("-----BEGIN CERTIFICATE-----"),
    "issueCert returns a non-empty PEM root",
  );
  // Consumers check issued material against the root issuance reports before they publish it.
  const now = yield* Clock.currentTimeMillis;
  yield* requireCaContract(
    certificatePairIsCurrent(
      { certificate: issued.certificate, privateKey },
      { names: [spec.cn, ...spec.sans], now, root: issued.root.certificate },
    ),
    "issueCert returns a current pair for the requested names, signed by the root it reports",
  );
  // The next apply judges that pair against `root`; an authority whose `root` disagrees with what
  // it signs with would have every consumer reissue on every apply.
  const rootAfter = yield* ca.root.pipe(
    mapFailures((d) => caContractFailure("root resolves after issuance", d)),
  );
  yield* requireCaContract(
    certificatePairIsCurrent(
      { certificate: issued.certificate, privateKey },
      { names: [spec.cn, ...spec.sans], now, root: rootAfter.certificate },
    ),
    "the issued pair verifies against the root the authority reports afterwards",
  );

  yield* ca
    .setup({ force: false, skipTrustInstall: true })
    .pipe(mapFailures((d) => caContractFailure("setup with skipTrustInstall resolves", d)));
});

/**
 * A recording authority that returns fixed, real material from `TEST_CERTIFICATES`: the contract
 * leaf (`test.lndo.site`, `*.test.lndo.site`) under rootA, whatever the request names. It issues
 * nothing new, so callers that need coverage of other names supply their own authority.
 */
export const makeTestCertificateAuthority = (): CertificateAuthorityShape & {
  readonly calls: ReadonlyArray<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  >;
} => {
  const calls: Array<
    | { readonly op: "setup"; readonly opts: CaSetupOptions }
    | { readonly op: "issueCert"; readonly spec: CertificateSpec }
  > = [];
  return {
    id: "test",
    setup: (opts) =>
      Effect.sync(() => {
        calls.push({ op: "setup", opts });
      }),
    root: Effect.succeed({ certificate: TEST_CERTIFICATES.rootA, trusted: true }),
    issueCert: (spec) =>
      Effect.sync((): IssuedCertificate => {
        calls.push({ op: "issueCert", spec });
        return {
          certificate: TEST_CERTIFICATES.contract.certificate,
          privateKey: Redacted.make(TEST_CERTIFICATES.contract.privateKey),
          root: { certificate: TEST_CERTIFICATES.rootA, trusted: true },
        };
      }),
    calls,
  };
};

export const TestCertificateAuthority: CertificateAuthorityShape = makeTestCertificateAuthority();
