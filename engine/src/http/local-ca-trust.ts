import { Cause, DateTime, Duration, Effect, Layer, Option } from "effect";

import {
  type LocalCaHopTrust,
  LocalCaTrustSource,
  isLocalProbeHost,
} from "@lando/http-client/local-ca-trust";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { CommandWarning } from "@lando/sdk/schema";
import { ConfigService, EventService } from "@lando/sdk/services";

import { commandWarningsUseMachineOutput, recordCommandWarning } from "../landofile/command-warnings.ts";
import { CertificateAuthorityResolver } from "../plugins/certificate-authority-resolver.ts";

const ROOT_READ_BUDGET = Duration.seconds(2);
const DEFAULT_DOMAIN = "lndo.site";

export const LOCAL_CA_UNTRUSTED_CODE = "LOCAL_CA_UNTRUSTED";

export const localCaUntrustedWarning = (): CommandWarning => ({
  code: LOCAL_CA_UNTRUSTED_CODE,
  message: "Browsers will warn on this app's HTTPS URLs because this machine does not trust the local CA.",
  remediation: "Run `lando setup` without `--skip-install-ca`.",
  context: { certsTrusted: "false" },
});

const readDomain = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ConfigService);
  if (Option.isNone(config)) return DEFAULT_DOMAIN;
  const loaded = yield* Effect.option(config.value.load);
  if (Option.isNone(loaded)) return DEFAULT_DOMAIN;
  return loaded.value.proxy?.defaultDomain ?? DEFAULT_DOMAIN;
});

const readRoot = Effect.gen(function* () {
  const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
  if (Option.isNone(resolver)) return undefined;
  const resolved = yield* Effect.exit(
    resolver.value.resolve.pipe(
      Effect.flatMap((authority) => authority.root),
      Effect.timeout(ROOT_READ_BUDGET),
    ),
  );
  if (resolved._tag === "Failure") {
    if (Cause.hasInterrupts(resolved.cause)) return yield* Effect.interrupt;
    return undefined;
  }
  return resolved.value;
});

export const layer = Layer.effect(
  LocalCaTrustSource,
  Effect.gen(function* () {
    const domain = yield* Effect.cached(readDomain);
    const root = yield* Effect.cached(readRoot);
    const prepare = (hostname: string) =>
      Effect.gen(function* () {
        const zone = yield* domain;
        const isLocalHost = (host: string) => isLocalProbeHost(host, zone);
        if (!isLocalHost(hostname)) return { pem: undefined, isLocalHost } satisfies LocalCaHopTrust;
        const found = yield* root;
        return { pem: found?.certificate, isLocalHost } satisfies LocalCaHopTrust;
      });
    return LocalCaTrustSource.of({
      prepare,
      trusted: Effect.flatMap(root, (found) => Effect.succeed(found?.trusted === true)),
    });
  }),
);

/** One warning when a local HTTPS URL was checked and the host does not trust the CA. */
export const warnIfLocalCaUntrusted = Effect.fnUntraced(function* (
  urls: readonly { readonly url: string }[],
) {
  const https = urls.filter((entry) => entry.url.startsWith("https:"));
  if (https.length === 0) return;
  const source = yield* Effect.serviceOption(LocalCaTrustSource);
  if (Option.isNone(source)) return;
  let localPem = false;
  for (const entry of https) {
    const hostname = URL.parse(entry.url)?.hostname;
    if (hostname === undefined) continue;
    const prepared = yield* source.value.prepare(hostname);
    if (prepared.isLocalHost(hostname) && prepared.pem !== undefined) {
      localPem = true;
      break;
    }
  }
  if (!localPem || (yield* source.value.trusted)) return;
  const warning = localCaUntrustedWarning();
  yield* recordCommandWarning(warning);
  if (yield* commandWarningsUseMachineOutput) return;
  const events = yield* Effect.serviceOption(EventService);
  if (Option.isNone(events)) return;
  yield* events.value
    .publish(
      MessageWarnEvent.make({
        body: `${warning.message} ${warning.remediation}`,
        timestamp: yield* DateTime.now,
      }),
    )
    .pipe(Effect.catchCause(() => Effect.void));
});
