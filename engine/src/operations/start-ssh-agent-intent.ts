import { SshAgentTransportError } from "@lando/sdk/errors";
import { ConfigService, LandofileService } from "@lando/sdk/services";
import { Effect } from "effect";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";
import { sshAgentEligibleServices } from "../subsystems/ssh-agent/overlay.ts";
import { resolveSshAgentIntent, sshAgentPlanExtension } from "../subsystems/ssh/intent.ts";

export const resolveStartSshAgentIntent = (target: ResolvedAppTarget) =>
  Effect.gen(function* () {
    const { plan, app: ref } = target;
    const config = yield* Effect.serviceOption(ConfigService);
    const landofiles = yield* Effect.serviceOption(LandofileService);
    const agentLandofile =
      target.landofile ??
      (ref.kind !== "global" && sshAgentEligibleServices(plan).length > 0 && landofiles._tag === "Some"
        ? yield* loadUserLandofileAt(landofiles.value, target.root).pipe(
            Effect.mapError(
              () =>
                new SshAgentTransportError({
                  message: "Unable to resolve the current SSH agent configuration.",
                  stage: "broker",
                  remediation: "Fix the app Landofile and retry lando start.",
                }),
            ),
          )
        : undefined);
    const extension = agentLandofile === undefined ? sshAgentPlanExtension(plan) : undefined;
    return resolveSshAgentIntent({
      landofile:
        agentLandofile ??
        (extension === undefined ? {} : { sshAgent: { sidecar: extension.mode !== "host" } }),
      globalConfig:
        config._tag === "Some" && ref.kind !== "global" && sshAgentEligibleServices(plan).length > 0
          ? yield* config.value.load.pipe(
              Effect.mapError(
                () =>
                  new SshAgentTransportError({
                    message: "Unable to resolve the global SSH agent configuration.",
                    stage: "broker",
                    remediation: "Fix the global configuration and retry lando start.",
                  }),
              ),
            )
          : undefined,
    });
  });
