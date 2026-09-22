import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  emptyPatch,
  isPlainObject,
} from "./lowering-contract.ts";
import { droppedServiceKey, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

export interface BuildHookOptions {
  readonly meUser?: string;
  readonly hasComposeBuild?: boolean;
}

type HookStep = { readonly run: string; readonly user?: string };

const PHASES = [
  ["build_as_root_internal", "artifact", true],
  ["build_as_root", "artifact", true],
  ["build_internal", "artifact", false],
  ["build", "artifact", false],
  ["run_as_root_internal", "app", true],
  ["run_as_root", "app", true],
  ["run_internal", "app", false],
  ["run", "app", false],
] as const;

export const lowerBuildHooks = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
  options: BuildHookOptions,
): LoweringPatch => {
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const steps: { readonly artifact: HookStep[]; readonly app: HookStep[] } = { artifact: [], app: [] };
  const meUser = options.meUser === "" ? undefined : options.meUser;
  let blocked = false;

  const lowerCommands = (value: unknown, relative: Lando3Path, user: string | undefined): HookStep[] => {
    if (value === undefined) return [];
    const commands: readonly unknown[] = Array.isArray(value) ? value : [value];
    return commands.flatMap((command, index): HookStep[] => {
      if (typeof command === "string") {
        return [user === undefined ? { run: command } : { run: command, user }];
      }
      blocked = true;
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: Array.isArray(value) ? [...relative, index] : relative,
          message: "Build and run hooks must be plain command strings; tagged references are not read.",
          remediation: "Replace this hook with an explicit command string before translating.",
        }),
      );
      return [];
    });
  };

  const build = service.build;
  const api4Build = isPlainObject(build) && !("tag" in build) ? build : undefined;
  for (const [phase, target, root] of PHASES) {
    if (phase === "build" && api4Build !== undefined) {
      steps.artifact.push(...lowerCommands(api4Build.image, ["build", "image"], meUser));
    } else {
      steps[target].push(...lowerCommands(service[phase], [phase], root ? "root" : meUser));
    }
  }
  if (api4Build !== undefined) {
    steps.app.push(...lowerCommands(api4Build.app, ["build", "app"], meUser));
    if (Object.hasOwn(api4Build, "dockerfile")) {
      diagnostics.push(
        droppedServiceKey({
          ctx,
          relative: ["build", "dockerfile"],
          message: "The API-4 build.dockerfile hook setting is not carried into Lando build steps.",
          remediation:
            "Review the Dockerfile intent and configure a separate Compose-family build if needed.",
        }),
      );
    }
  }

  const hasSteps = steps.artifact.length > 0 || steps.app.length > 0;
  if (hasSteps) {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative: ["build"],
        message:
          "Build and run phases collapsed into ordered artifact and app steps: root before user, internal before authored commands.",
        remediation: "Review the ordered steps and their users before building the app.",
      }),
    );
    if (options.hasComposeBuild === true) {
      blocked = true;
      diagnostics.push(
        unsupportedServiceKey({
          ctx,
          relative: ["build"],
          message: "Lando artifact/app hooks cannot share a build block with Compose build intent.",
          remediation: "Choose one build family or move the Compose build into a separate service or image.",
        }),
      );
    }
  }
  if (!hasSteps && diagnostics.length === 0) return emptyPatch;
  return {
    patch: hasSteps
      ? {
          build: {
            ...(steps.artifact.length > 0 ? { artifact: steps.artifact } : {}),
            ...(steps.app.length > 0 ? { app: steps.app } : {}),
          },
        }
      : {},
    diagnostics,
    ...(blocked ? { blocked: true } : {}),
  };
};
