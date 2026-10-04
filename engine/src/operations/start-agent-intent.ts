import type { AppPlan, GlobalConfig, LandofileShape, ServicePlan } from "@lando/sdk/schema";
import { ConfigService, LandofileService } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { type ResolvedAppTarget, loadUserLandofileAt } from "../landofile/app-resolution.ts";

type AgentLandofile = Pick<LandofileShape, "sshAgent" | "gpgAgent">;

interface StartAgentIntentConfig<Extension, Intent, Error> {
  readonly label: "SSH" | "GPG";
  readonly error: new (fields: {
    readonly message: string;
    readonly stage: "broker";
    readonly remediation: string;
  }) => Error;
  readonly eligibleServices: (plan: AppPlan) => readonly ServicePlan[];
  readonly planExtension: (plan: AppPlan) => Extension | undefined;
  readonly fallbackLandofile: (extension: Extension) => AgentLandofile;
  readonly resolveIntent: (input: {
    readonly landofile: AgentLandofile;
    readonly globalConfig: GlobalConfig | undefined;
  }) => Intent;
}

export const resolveStartAgentIntent = <Extension, Intent, Error>(
  config: StartAgentIntentConfig<Extension, Intent, Error>,
) =>
  Effect.fnUntraced(function* (target: ResolvedAppTarget) {
    const { plan, app: ref } = target;
    const global = yield* Effect.serviceOption(ConfigService);
    const landofiles = yield* Effect.serviceOption(LandofileService);
    const eligible = ref.kind !== "global" && config.eligibleServices(plan).length > 0;
    const agentLandofile =
      target.landofile ??
      (eligible && Option.isSome(landofiles)
        ? yield* loadUserLandofileAt(landofiles.value, target.root).pipe(
            Effect.mapError(
              () =>
                new config.error({
                  message: `Unable to resolve the current ${config.label} agent configuration.`,
                  stage: "broker",
                  remediation: "Fix the app Landofile and retry lando start.",
                }),
            ),
          )
        : undefined);
    const extension = agentLandofile === undefined ? config.planExtension(plan) : undefined;
    return config.resolveIntent({
      landofile: agentLandofile ?? (extension === undefined ? {} : config.fallbackLandofile(extension)),
      globalConfig:
        Option.isSome(global) && eligible
          ? yield* global.value.load.pipe(
              Effect.mapError(
                () =>
                  new config.error({
                    message: `Unable to resolve the global ${config.label} agent configuration.`,
                    stage: "broker",
                    remediation: "Fix the global configuration and retry lando start.",
                  }),
              ),
            )
          : undefined,
    });
  });
