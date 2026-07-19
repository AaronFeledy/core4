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

import { inputBooleanFlag } from "./setup-inputs.ts";
import type { SetupReadinessRecorder } from "./setup-steps.ts";

type SetupPrivilegeOptions = {
  readonly privilege?: Context.Tag.Service<typeof PrivilegeService>;
};

export const runCaSetupStep = (
  input: unknown,
  privilegeOptions: SetupPrivilegeOptions,
  recorder: SetupReadinessRecorder,
) =>
  Effect.gen(function* () {
    const ca = yield* Effect.serviceOption(CertificateAuthority);
    if (ca._tag === "Some") {
      yield* ca.value
        .setup({
          force: false,
          ...privilegeOptions,
          ...(inputBooleanFlag(input, "skip-install-ca") ? { skipTrustInstall: true } : {}),
        })
        .pipe(Effect.tapError((cause) => recorder.recordFailure("ca", cause)));
      yield* recorder.record({
        id: "ca",
        status: inputBooleanFlag(input, "skip-install-ca") ? "skipped" : "satisfied",
        evidence: inputBooleanFlag(input, "skip-install-ca")
          ? "Certificate authority trust installation skipped by --skip-install-ca."
          : "Certificate authority setup completed.",
      });
    } else if (inputBooleanFlag(input, "skip-install-ca")) {
      yield* recorder.record({
        id: "ca",
        status: "skipped",
        evidence: "Certificate authority trust installation skipped by --skip-install-ca.",
      });
    } else {
      yield* recorder.recordUnavailable("ca", "Certificate authority");
    }
  });

export const runProxySetupStep = (input: unknown, recorder: SetupReadinessRecorder) =>
  Effect.gen(function* () {
    if (!inputBooleanFlag(input, "skip-proxy")) {
      const proxy = yield* Effect.serviceOption(ProxyService);
      if (proxy._tag === "Some") {
        yield* proxy.value.setup().pipe(Effect.tapError((cause) => recorder.recordFailure("proxy", cause)));
        yield* recorder.record({ id: "proxy", status: "satisfied", evidence: "Proxy setup completed." });
      } else {
        yield* recorder.recordUnavailable("proxy", "Proxy");
      }
    } else {
      yield* recorder.record({
        id: "proxy",
        status: "skipped",
        evidence: "Proxy setup skipped by --skip-proxy.",
      });
    }
  });

export const runShellServiceSetupStep = (input: unknown, recorder: SetupReadinessRecorder) =>
  Effect.gen(function* () {
    if (!inputBooleanFlag(input, "skip-shell-integration")) {
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
        yield* recorder.recordUnavailable("shell", "Shell integration");
      }
    } else {
      yield* recorder.record({
        id: "shell",
        status: "skipped",
        evidence: "Shell integration skipped by --skip-shell-integration.",
      });
    }
  });
