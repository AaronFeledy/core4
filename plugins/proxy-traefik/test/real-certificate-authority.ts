import type { TlsPeerInput } from "@lando/http-client/tls-peer";
import { certificateIsCurrent } from "@lando/sdk/certificates";
import type { CertificateSpec } from "@lando/sdk/services";
import { Clock, Effect, Redacted } from "effect";
import fixtures from "./issued-certificate-fixtures.json";

export const rootPem = fixtures.root;
const pairs = new Map(Object.entries(fixtures.pairs));
export const issueFixturePair = (spec: CertificateSpec) => {
  const names = [...new Set([spec.cn, ...spec.sans])].sort();
  const key = JSON.stringify(names);
  const pair = pairs.get(key);
  if (pair === undefined) throw new Error(`Missing real router certificate fixture for ${key}`);
  return pair;
};

export const realCertificateAuthority = {
  id: "fixture-ca",
  setup: () => Effect.void,
  root: Effect.succeed({ certificate: rootPem, trusted: true }),
  issueCert: (spec: CertificateSpec) =>
    Effect.sync(() => {
      const pair = issueFixturePair(spec);
      return {
        certificate: pair.certificate,
        privateKey: Redacted.make(pair.privateKey),
        root: { certificate: rootPem, trusted: true },
      };
    }),
};

export const observeFixtureTlsPeer =
  (files: ReadonlyMap<string, string>) =>
  ({ hostname }: TlsPeerInput) =>
    Clock.currentTimeMillis.pipe(
      Effect.map(
        (now) =>
          [...files.values()].find((certificate) =>
            certificateIsCurrent(certificate, { names: [hostname], now, root: rootPem }),
          ) ?? "",
      ),
    );
