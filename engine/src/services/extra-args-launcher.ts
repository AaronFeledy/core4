import type { ServicePlan } from "@lando/sdk/schema";
import type {
  LauncherCommandOptions,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
} from "@lando/sdk/services";
import { Effect } from "effect";
import { type DraftServicePlan, writeServiceCommand } from "./draft.ts";

export interface ExtraArgsLauncher {
  readonly command: readonly string[];
  readonly entrypoint?: NonNullable<ServicePlan["entrypoint"]>;
  readonly extraArgs: NonNullable<LauncherCommandOptions["extraArgs"]>;
}

export const captureExtraArgsLauncher = (
  draft: DraftServicePlan,
  features: ReadonlySet<string> | undefined,
) => {
  let current: ExtraArgsLauncher | undefined;
  return {
    get current() {
      return current;
    },
    capture: Effect.fnUntraced(function* (
      feature: string,
      apply: (
        setCommand: ServiceFeatureContext["setCommand"],
      ) => ReturnType<ServiceFeatureDefinition["apply"]>,
    ) {
      let launcher: Omit<ExtraArgsLauncher, "entrypoint"> | undefined;
      yield* apply((command, options) => {
        writeServiceCommand(draft, command, options);
        if (options?.extraArgs === undefined || typeof command === "string") return;
        const snapshot = [...command];
        if (features?.has(feature)) launcher = { command: snapshot, extraArgs: options.extraArgs };
      });
      if (launcher !== undefined) {
        current ??= {
          ...launcher,
          ...(draft.entrypoint === undefined ? {} : { entrypoint: draft.entrypoint }),
        };
      }
    }),
  };
};
