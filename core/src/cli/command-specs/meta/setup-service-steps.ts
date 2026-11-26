/**
 * `meta:setup` optional-service setup steps (router, shell integration, shell profile PATH).
 *
 * Each step resolves its service optionally, runs its `setup`, and records the
 * readiness outcome (satisfied / skipped / unavailable / failed) — honoring the
 * matching `--skip-*` flag. They are pulled out of the command orchestration so
 * each service concern reads as one unit.
 */

import { resolveProxyDefaultDomain } from "@lando/engine/config/proxy-default-domain";
import { resolveRouterConfigForApp } from "@lando/engine/config/router-config";
import {
  SSH_SIDECAR_READINESS_POLICY,
  awaitRuntimeSshAgent,
} from "@lando/engine/subsystems/ssh-agent/session";
import { mapFailures } from "@lando/sdk/command-result";
import { SshAgentUnavailableError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import { EventService, type PrivilegeService, RouterService, SshService } from "@lando/sdk/services";
import { type Context, DateTime, Duration, Effect, Result } from "effect";
import { CliInvocation } from "../../../runtime/invocation-context";
import { resolveSecretsRedactor } from "../../commands/secrets-redactor";
import { ShellenvInstallRecordError, installShellProfileIntegration } from "../../commands/shellenv";
import { inputBooleanFlag } from "./setup-inputs";
import { SYSTEM_RUNTIME_PROVIDERS } from "./setup-provider-selection";
import { type SetupReadinessRecorder, ShellProfileIntegrationError } from "./setup-steps";

export const recordAbsentHostIntegration = (
  recorder: SetupReadinessRecorder,
  selectedProviderId: string,
  id: string,
  serviceName: string,
): Effect.Effect<void, never> => {
  if (selectedProviderId in SYSTEM_RUNTIME_PROVIDERS) {
    return recorder.record({
      id,
      status: "skipped",
      evidence: `${serviceName} skipped because the host-integration service is not provided on this layer.`,
    });
  }
  return recorder.recordUnavailable(id, serviceName);
};

export const runProxySetupStep = Effect.fn("SetupCommand.runProxySetupStep")(function* (
  input: unknown,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
) {
  if (inputBooleanFlag(input, "skip-proxy")) {
    yield* recorder.record({
      id: "proxy",
      status: "skipped",
      evidence: "Router setup skipped by --skip-proxy.",
    });
    return;
  }
  const proxy = yield* Effect.serviceOption(RouterService);
  if (proxy._tag === "Some") {
    const defaultDomain = yield* resolveProxyDefaultDomain;
    const { router, routerPin } = yield* resolveRouterConfigForApp();
    // `--no-interactive` declines privileged host changes; only `--yes` approves them.
    const autoApprove = inputBooleanFlag(input, "yes");
    yield* Effect.scoped(
      proxy.value.setup(
        { defaultDomain, router, routerPin },
        { intent: "configure", autoApprove, reacquirePorts: true },
      ),
    ).pipe(Effect.tapError((cause) => recorder.recordFailure("proxy", cause)));
    yield* recorder.record({ id: "proxy", status: "satisfied", evidence: "Router setup completed." });
  } else {
    yield* recordAbsentHostIntegration(recorder, selectedProviderId, "proxy", "Proxy");
  }
});

export const runShellServiceSetupStep = Effect.fn("SetupCommand.runShellServiceSetupStep")(function* (
  input: unknown,
  recorder: SetupReadinessRecorder,
  selectedProviderId = "lando",
) {
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
    const setup = yield* Effect.result(
      Effect.gen(function* () {
        yield* ssh.value.setup({ force: false });
        if (ssh.value.id !== "sidecar") return;
        const { state, detail } = yield* awaitRuntimeSshAgent();
        if (state !== "ready") {
          return yield* Effect.fail(
            new SshAgentUnavailableError({
              mode: "sidecar",
              reason: "sidecar-not-running",
              ...(detail === undefined ? {} : { detail }),
              message:
                (state === "stopped"
                  ? "The SSH agent sidecar stopped before its agent answered."
                  : `The SSH agent sidecar started, but its agent did not answer within ${Duration.toSeconds(SSH_SIDECAR_READINESS_POLICY.timeout)} seconds.`) +
                (detail === undefined ? "" : ` Last probe failure: ${detail}`),
              remediation:
                "Run `lando global:logs --service ssh-agent` to see why, fix the cause, then run `lando setup`.",
            }),
          );
        }
      }),
    );
    if (Result.isFailure(setup)) {
      const { redact } = yield* resolveSecretsRedactor({ sourceEnv: (yield* CliInvocation).env });
      const evidence = redact(setup.failure.message);
      const setupCommand =
        selectedProviderId in SYSTEM_RUNTIME_PROVIDERS
          ? `lando setup --provider=${selectedProviderId}`
          : "lando setup";
      const remediation = `Apps still start without SSH agent forwarding. Fix the cause, then rerun \`${setupCommand}\`.`;
      yield* recorder.record({ id: "shell", status: "unavailable", evidence, remediation });
      const events = yield* Effect.serviceOption(EventService);
      if (events._tag === "Some") {
        yield* events.value
          .publish(
            MessageWarnEvent.make({
              body: `${evidence}${/[.!?]$/.test(evidence) ? "" : "."} ${remediation}`,
              timestamp: yield* DateTime.now,
            }),
          )
          .pipe(Effect.ignore);
      }
      return;
    }
    yield* recorder.record({
      id: "shell",
      status: "satisfied",
      evidence: "Shell integration setup completed.",
    });
  } else {
    yield* recordAbsentHostIntegration(recorder, selectedProviderId, "shell", "Shell integration");
  }
});

const SHELL_PROFILE_REMEDIATION =
  "Fix shell profile write permissions, then rerun `lando setup` or `lando shellenv` to finish PATH integration.";

/** Add Lando to the user's shell profile PATH; Windows and non-interactive runs leave the profile alone. */
export const runShellProfileSetupStep = Effect.fn("SetupCommand.runShellProfileSetupStep")(function* (
  input: unknown,
  privilege: Context.Service.Shape<typeof PrivilegeService>,
  userDataRoot: string,
  recorder: SetupReadinessRecorder,
) {
  if (
    process.platform === "win32" ||
    inputBooleanFlag(input, "skip-shell-integration") ||
    inputBooleanFlag(input, "no-interactive")
  ) {
    return;
  }
  const shellProfile = yield* Effect.try({
    try: () => installShellProfileIntegration(userDataRoot, privilege),
    catch: (cause) => {
      if (!(cause instanceof ShellenvInstallRecordError)) throw cause;
      return new ShellProfileIntegrationError({
        message: "Shell profile integration failed.",
        stderr: cause.message,
        remediation: SHELL_PROFILE_REMEDIATION,
      });
    },
  }).pipe(
    Effect.flatten,
    mapFailures((cause) =>
      cause instanceof ShellProfileIntegrationError
        ? cause
        : new ShellProfileIntegrationError({
            message: "Shell profile integration failed.",
            stderr: cause.message,
            remediation: cause.remediation,
          }),
    ),
    Effect.tapError((cause) => recorder.recordFailure("shell", cause.stderr)),
  );
  if (shellProfile.exitCode !== 0) {
    yield* recorder.recordFailure("shell", shellProfile.stderr);
    return yield* Effect.fail(
      new ShellProfileIntegrationError({
        message: "Shell profile integration failed.",
        stderr: shellProfile.stderr,
        remediation: SHELL_PROFILE_REMEDIATION,
      }),
    );
  }
});
