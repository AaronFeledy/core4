import { ConfigService } from "@lando/sdk/services";
import { Effect } from "effect";

import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding } from "./doctor-contract";
import { resolveSecretsRedactor } from "./secrets-redactor";
import { resolveSetupNetworkTrust } from "./setup-network-trust";

export const networkTrustDoctorStatus = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<DoctorFinding, never, ConfigService> {
  const configService = yield* ConfigService;
  const config = yield* configService.load;
  const proxyUrls: ReadonlyArray<string | undefined> = [
    config.network?.proxy?.http ?? undefined,
    config.network?.proxy?.https ?? undefined,
  ];
  const redactionOptions = {
    sourceEnv: env,
    proxyUrls,
  };
  const { redactor } = yield* resolveSecretsRedactor(redactionOptions);

  return yield* resolveSetupNetworkTrust(config, env).pipe(
    Effect.match({
      onFailure: (error): DoctorFinding => {
        const message = redactor.redactString(error.message);
        const remediation = redactor.redactString(error.remediation);
        return warnCheck({
          name: "network-trust",
          recovery: "manual",
          context: {
            failure: error.kind,
            message,
            remediation,
          },
          solutions: [{ kind: "manual", description: remediation, command: "lando setup" }],
        });
      },
      onSuccess: (network): DoctorFinding =>
        passCheckNamed({
          name: "network-trust",
          recovery: "manual",
          context: {
            caConfigured: String(network.ca.certs.length > 0),
            caCount: String(network.ca.certs.length),
            caLoaded: String(network.ca.loadedCerts.length),
            caTrustHost: String(network.ca.trustHost),
            caInjectIntoServices: String(network.ca.injectIntoServices),
            proxyConfigured: String(network.proxy.http !== undefined || network.proxy.https !== undefined),
            proxyInjectIntoServices: String(network.proxy.injectIntoServices),
            noProxyCount: String(network.proxy.noProxy.length),
          },
        }),
    }),
  );
});
