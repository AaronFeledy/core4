import { Effect, Option } from "effect";

import type { ConfigError } from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { DoctorSeverity, DoctorSolution, DoctorStatus } from "./doctor-contract";
import type { SubsystemRecovery } from "./doctor-subsystem-checks";
import { resolveSetupNetworkTrust } from "./setup-network-trust";

export interface NetworkTrustDoctorStatus {
  readonly name: "network-trust";
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly recovery: SubsystemRecovery;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
}

export const networkTrustDoctorStatus = (
  env: NodeJS.ProcessEnv,
): Effect.Effect<NetworkTrustDoctorStatus, ConfigError, ConfigService> =>
  Effect.gen(function* () {
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
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactor = Option.isSome(redactionService)
      ? yield* redactionService.value.forProfile("secrets", redactionOptions)
      : createStandaloneRedactor("secrets", redactionOptions);

    return yield* resolveSetupNetworkTrust(config, env).pipe(
      Effect.match({
        onFailure: (error): NetworkTrustDoctorStatus => {
          const message = redactor.redactString(error.message);
          const remediation = redactor.redactString(error.remediation);
          return {
            name: "network-trust",
            status: "warn",
            severity: "warn",
            recovery: "manual",
            context: {
              failure: error.kind,
              message,
              remediation,
            },
            solutions: [{ kind: "manual", description: remediation, command: "lando setup" }],
          };
        },
        onSuccess: (network): NetworkTrustDoctorStatus => ({
          name: "network-trust",
          status: "pass",
          severity: "info",
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
          solutions: [],
        }),
      }),
    );
  });
