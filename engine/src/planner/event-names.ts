import { getInternalToolingTasks } from "@lando/landofile/tooling-include-provenance";
import { LandofileUnknownEventError } from "@lando/sdk/errors";
import { AppLifecycleEventName, type LandofileShape } from "@lando/sdk/schema";
import type { EffectiveTooling } from "./effective-tooling.ts";

export const validEventNames = (effectiveTooling: EffectiveTooling): ReadonlyArray<string> => {
  const internal = new Set(getInternalToolingTasks(effectiveTooling));
  const brackets = Object.keys(effectiveTooling)
    .filter((name) => !internal.has(name))
    .flatMap((name) => [`pre-${name}`, `post-${name}`])
    .sort();
  return [...new Set([...AppLifecycleEventName.literals, ...brackets])];
};

export const unknownEventName = (
  events: LandofileShape["events"],
  valid: ReadonlyArray<string>,
): string | undefined => {
  const names = new Set(valid);
  return Object.keys(events ?? {}).find((name) => !names.has(name));
};

export const unknownEventError = (
  event: string,
  valid: ReadonlyArray<string>,
  file: string,
): LandofileUnknownEventError =>
  new LandofileUnknownEventError({
    message: `Unknown app event ${event}. Valid events: ${valid.join(", ")}.`,
    event,
    validEvents: [...valid],
    file,
    remediation: `Use one of: ${valid.join(", ")}.`,
  });
