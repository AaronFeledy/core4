/**
 * `meta:setup` optional-service setup steps (CA, proxy, shell integration).
 *
 * Each step resolves its service optionally, runs its `setup`, and records the
 * readiness outcome (satisfied / skipped / unavailable / failed) — honoring the
 * matching `--skip-*` flag. They are pulled out of the command orchestration so
 * each service concern reads as one unit.
 */
import { type Context, Effect } from "effect";

import { CertificateAuthority, type PrivilegeService, ProxyService, SshService } from "@lando/sdk/services";

import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { inputBooleanFlag } from "./setup-inputs";
import { SYSTEM_RUNTIME_PROVIDERS } from "./setup-provider-selection";
import type { SetupReadinessRecorder } from "./setup-steps";

type SetupPrivilegeOptions = {
  readonly privilege?: Context.Tag.Service<typeof PrivilegeService>;
};

const SKIP_CA_TRUST_EVIDENCE = "Certificate authority trust installation skipped by --skip-install-ca.";

const recordAbsentHostIntegration = (
  recorder: SetupReadinessRecorder,
  selectedProviderId: string,
  id: string,
  serviceName: string,
): Effect.Effect<void, never> => {
  if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
    return recorder.record({
      id,
      status: "skipped",
      evidence: `${serviceName} is optional on the ${selectedProviderId} system runtime.`,
    });
  }
  return recorder.recordUnavailable(id, serviceName);
};

export const runCaSetupStep = (
  input: unknown,
  privilegeOptions: SetupPrivilegeOptions,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
) =>
  Effect.gen(function* () {
    const skipTrustInstall = inputBooleanFlag(input, "skip-install-ca");
    const resolver = yield* Effect.serviceOption(CertificateAuthorityResolver);
    const authority = yield* Effect.serviceOption(CertificateAuthority);
    if (resolver._tag === "None" && authority._tag === "None") {
      if (skipTrustInstall) {
        yield* recorder.record({ id: "ca", status: "skipped", evidence: SKIP_CA_TRUST_EVIDENCE });
      } else {
        yield* recordAbsentHostIntegration(recorder, selectedProviderId, "ca", "Certificate authority");
      }
      return;
    }
    const ca =
      resolver._tag === "Some"
        ? yield* resolver.value.resolve.pipe(
            Effect.catchTag("NoCertificateAuthorityError", (cause) =>
              Effect.as(
                skipTrustInstall
                  ? recorder.record({ id: "ca", status: "skipped", evidence: SKIP_CA_TRUST_EVIDENCE })
                  : recorder.record({
                      id: "ca",
                      status: "unavailable",
                      evidence: cause.message,
                      remediation: cause.remediation,
                    }),
                undefined,
              ),
            ),
            Effect.catchTag("AmbiguousCertificateAuthoritiesError", (cause) =>
              Effect.as(
                recorder.record({
                  id: "ca",
                  status: "failed",
                  evidence: cause.message,
                  remediation: cause.remediation,
                }),
                undefined,
              ),
            ),
            Effect.tapError((cause) => recorder.recordFailure("ca", cause)),
          )
        : authority._tag === "Some"
          ? authority.value
          : undefined;
    if (ca !== undefined) {
      yield* ca
        .setup({
          force: false,
          ...privilegeOptions,
          ...(skipTrustInstall ? { skipTrustInstall: true } : {}),
        })
        .pipe(Effect.tapError((cause) => recorder.recordFailure("ca", cause)));
      yield* recorder.record({
        id: "ca",
        status: skipTrustInstall ? "skipped" : "satisfied",
        evidence: skipTrustInstall ? SKIP_CA_TRUST_EVIDENCE : "Certificate authority setup completed.",
      });
    }
  });

export const runProxySetupStep = (
  input: unknown,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
) =>
  Effect.gen(function* () {
    if (inputBooleanFlag(input, "skip-proxy")) {
      yield* recorder.record({
        id: "proxy",
        status: "skipped",
        evidence: "Proxy setup skipped by --skip-proxy.",
      });
      return;
    }
    const proxy = yield* Effect.serviceOption(ProxyService);
    if (proxy._tag === "Some") {
      yield* Effect.scoped(proxy.value.setup({ defaultDomain: "lndo.site" })).pipe(
        Effect.tapError((cause) => recorder.recordFailure("proxy", cause)),
      );
      yield* recorder.record({ id: "proxy", status: "satisfied", evidence: "Proxy setup completed." });
    } else {
      yield* recordAbsentHostIntegration(recorder, selectedProviderId, "proxy", "Proxy");
    }
  });

export const runShellServiceSetupStep = (
  input: unknown,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
) =>
  Effect.gen(function* () {
    if (inputBooleanFlag(input, "skip-shell-integration")) {
      yield* recorder.record({
        id: "shell",
        status: "skipped",
        evidence: "Shell integration skipped by --skip-shell-integration.",
      });
      return;
    }
    const ssh = yield* Effect.serviceOption(SshService);
    if (ssh._tag === "Some") {
      yield* ssh.value
        .setup({ force: false })
        .pipe(Effect.tapError((cause) => recorder.recordFailure("shell", cause)));
      yield* recorder.record({
        id: "shell",
        status: "satisfied",
        evidence: "Shell integration setup completed.",
      });
    } else {
      yield* recordAbsentHostIntegration(recorder, selectedProviderId, "shell", "Shell integration");
    }
  });
