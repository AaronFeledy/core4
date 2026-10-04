import { Effect } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor-contract";
import type { SubsystemRecovery } from "./doctor-subsystem-checks";
import { resolveSecretsRedactor } from "./secrets-redactor";
import { resolveSetupNetworkTrust } from "./setup-network-trust";

export interface NetworkTrustDoctorStatus {
  readonly name: "network-trust";
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly recovery: SubsystemRecovery;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export const networkTrustDoctorStatus = Effect.fnUntraced(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<NetworkTrustDoctorStatus, ConfigError, ConfigService> {
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
      onFailure: (error): NetworkTrustDoctorStatus => {
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
      onSuccess: (network): NetworkTrustDoctorStatus =>
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
