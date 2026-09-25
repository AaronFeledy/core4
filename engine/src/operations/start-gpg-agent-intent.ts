import { GpgAgentTransportError } from "@lando/sdk/errors";
import { ConfigService, LandofileService } from "@lando/sdk/services";
import { Effect } from "effect";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";
import { gpgAgentPlanExtension, resolveGpgAgentIntent } from "../subsystems/gpg-agent/intent.ts";
import { gpgAgentEligibleServices } from "../subsystems/gpg-agent/overlay.ts";

export const resolveStartGpgAgentIntent = (target: ResolvedAppTarget) =>
  Effect.gen(function* () {
    const { plan, app: ref } = target;
    const config = yield* Effect.serviceOption(ConfigService);
    const landofiles = yield* Effect.serviceOption(LandofileService);
    const agentLandofile =
      target.landofile ??
      (ref.kind !== "global" && gpgAgentEligibleServices(plan).length > 0 && landofiles._tag === "Some"
        ? yield* loadUserLandofileAt(landofiles.value, target.root).pipe(
            Effect.mapError(
              () =>
                new GpgAgentTransportError({
                  message: "Unable to resolve the current GPG agent configuration.",
                  stage: "broker",
                  remediation: "Fix the app Landofile and retry lando start.",
                }),
            ),
          )
        : undefined);
    return resolveGpgAgentIntent({
      landofile:
        agentLandofile ??
        (gpgAgentPlanExtension(plan) === undefined
          ? {}
          : { gpgAgent: { forward: gpgAgentPlanExtension(plan)?.forward ?? false } }),
      globalConfig:
        config._tag === "Some" && ref.kind !== "global" && gpgAgentEligibleServices(plan).length > 0
          ? yield* config.value.load.pipe(
              Effect.mapError(
                () =>
                  new GpgAgentTransportError({
                    message: "Unable to resolve the global GPG agent configuration.",
                    stage: "broker",
                    remediation: "Fix the global configuration and retry lando start.",
                  }),
              ),
            )
          : undefined,
    });
  });
