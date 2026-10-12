import { RedactionService } from "@lando/redaction/service";
import { identityRedactor } from "@lando/sdk/command-result";
import { SshAgentUnavailableError } from "@lando/sdk/errors";
import type { AppId } from "@lando/sdk/schema";
import { EventService, type SshService } from "@lando/sdk/services";
import { makeTaskTree, runWithTaskTree } from "@lando/sdk/task-progress";
import { type Context, Duration, Effect, Option } from "effect";
import { probeSshAgent } from "../subsystems/ssh-agent/agent-probe.ts";
import type { AgentRelayUpstream } from "../subsystems/ssh-agent/relay.ts";
import {
  SSH_SIDECAR_READINESS_POLICY,
  awaitRuntimeSshAgent,
  runtimeSshAgentState,
} from "../subsystems/ssh-agent/session.ts";
import { startSshSidecarTreeId } from "./start-progress.ts";

// The sidecar always runs on the managed runtime, so its container state ends the wait early
// even when the app reaches the agent through a host socket.
const hostSocketState = (upstream: AgentRelayUpstream) =>
  runtimeSshAgentState.pipe(
    Effect.flatMap((sidecar) =>
      sidecar === "stopped"
        ? Effect.succeed(sidecar)
        : Effect.tryPromise({
            try: () => probeSshAgent(upstream, { timeoutMs: 2_000 }),
            catch: (cause: unknown) => cause,
          }).pipe(
            Effect.as("ready" as const),
            Effect.catch(() => Effect.succeed("starting" as const)),
          ),
    ),
  );

export const startSshSidecar = Effect.fnUntraced(function* (
  input: { readonly appId: AppId; readonly appName?: string },
  ssh: Context.Service.Shape<typeof SshService>,
  upstream: AgentRelayUpstream | { readonly _tag: "volume"; readonly volume: string },
) {
  const events = yield* EventService;
  return yield* runWithTaskTree(
    makeTaskTree(events, {
      parentId: startSshSidecarTreeId(input.appId),
      label: `SSH agent sidecar ${input.appName ?? input.appId}`,
      children: [{ id: "start", label: "Start SSH agent sidecar" }],
      prefixChildIds: true,
    }),
    (tree) =>
      Effect.gen(function* () {
        yield* tree.startTask("start");
        yield* ssh.setup({ force: false }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const redaction = yield* Effect.serviceOption(RedactionService);
              const redactor = Option.isSome(redaction)
                ? yield* redaction.value.forProfile("secrets")
                : identityRedactor;
              return yield* Effect.fail(
                new SshAgentUnavailableError({
                  mode: "sidecar",
                  reason: "sidecar-not-running",
                  message: redactor.redactString(error.message),
                  remediation:
                    "Fix the cause, then run `lando restart`. `lando global:logs --service ssh-agent` shows the sidecar's output.",
                }),
              );
            }),
          ),
        );
        const state = yield* awaitRuntimeSshAgent(
          upstream._tag === "volume" ? runtimeSshAgentState : hostSocketState(upstream),
        );
        if (state !== "ready")
          return yield* Effect.fail(
            new SshAgentUnavailableError({
              mode: "sidecar",
              reason: "sidecar-not-running",
              message:
                state === "stopped"
                  ? "The SSH agent sidecar stopped before its agent answered."
                  : `The SSH agent sidecar started, but its agent did not answer within ${Duration.toSeconds(SSH_SIDECAR_READINESS_POLICY.timeout)} seconds.`,
              remediation:
                "Run `lando global:logs --service ssh-agent` to see why, fix the cause, then run `lando restart`.",
            }),
          );
        yield* tree.completeTask("start");
        return upstream;
      }),
    {
      success: "SSH agent sidecar ready",
      failure: "SSH agent sidecar unavailable",
      interrupt: "SSH agent sidecar interrupted",
    },
  );
});
