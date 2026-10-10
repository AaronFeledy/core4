import { join } from "node:path";
import { SshAgentTransportError } from "@lando/sdk/errors";
import { type AppPlan, type AppRef, SSH_AGENT_SOCKET_NAME } from "@lando/sdk/schema";
import { PathsService, SshService } from "@lando/sdk/services";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Option } from "effect";
import { gpgAgentEligibleServices, withGpgAgentOverlay } from "../subsystems/gpg-agent/overlay.ts";
import { sshAgentEligibleServices, withSshAgentOverlay } from "../subsystems/ssh-agent/overlay.ts";
import { readAgentRelayWorkerRecord } from "../subsystems/ssh-agent/worker-state.ts";
import { sshAgentPlanExtension } from "../subsystems/ssh/intent.ts";

export const withRetainedAgentOverlays = Effect.fnUntraced(function* (plan: AppPlan, app: AppRef) {
  const paths = yield* PathsService;
  const privateFileAccess = yield* PrivateFileAccessService;
  let overlaid = plan;
  for (const kind of ["ssh", "gpg"] as const) {
    const eligible = kind === "ssh" ? sshAgentEligibleServices(plan) : gpgAgentEligibleServices(plan);
    if (eligible.length === 0) continue;
    const record = yield* readAgentRelayWorkerRecord(app, {
      kind,
      paths: { ...paths.roots, platform: paths.platform },
      privateFileAccess,
    });
    if (record !== undefined) {
      if (record.appId !== app.id || record.appRoot !== app.root || record.kind !== kind) {
        return yield* Effect.fail(
          new SshAgentTransportError({
            stage: "worker",
            message: "Retained agent relay belongs to a different app.",
            remediation: "Inspect this app's relay worker state before retrying selected restart.",
          }),
        );
      }
      overlaid =
        kind === "ssh"
          ? withSshAgentOverlay(overlaid, record)
          : withGpgAgentOverlay(
              overlaid,
              record,
              join(paths.agentRelayRunDir("gpg", app.id, app.root), "keyring"),
            );
    } else if (
      kind === "ssh" &&
      plan.provider === "lando" &&
      sshAgentPlanExtension(plan)?.mode === "sidecar"
    ) {
      const ssh = yield* Effect.serviceOption(SshService);
      if (Option.isSome(ssh)) {
        const socket = yield* ssh.value.getAgentSocket(plan.id).pipe(
          Effect.mapError(
            (cause) =>
              new SshAgentTransportError({
                stage: "worker",
                message: "Unable to resolve the retained SSH sidecar socket.",
                remediation: "Inspect the SSH sidecar socket before retrying selected restart.",
                cause,
              }),
          ),
        );
        if (socket.runtimeVolume !== undefined) {
          overlaid = withSshAgentOverlay(overlaid, {
            kind: "ssh",
            socketName: SSH_AGENT_SOCKET_NAME,
            mount: { _tag: "volume", volume: socket.runtimeVolume },
          });
        }
      }
    }
  }
  return overlaid;
});
