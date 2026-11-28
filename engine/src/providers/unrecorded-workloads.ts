import { destroyCommand } from "@lando/sdk/engine-placement";
import { AppResolveError } from "@lando/sdk/errors";
import { type AbsolutePath, type AppRef, ProviderId, type ResourceOwnership } from "@lando/sdk/schema";
import type { AppliedOrphanGroup } from "@lando/sdk/services";

const NAMED_CONTAINERS = 5;

export interface UnrecordedWorkloadEvidence {
  readonly root: AbsolutePath;
  readonly app: Pick<AppRef, "kind" | "id">;
  readonly groups: ReadonlyArray<AppliedOrphanGroup>;
  readonly ownership: ReadonlyArray<ResourceOwnership>;
  /** Providers whose runtime answered, so a recorded container they did not report is gone. */
  readonly observed: ReadonlySet<string>;
}

const named = (names: ReadonlyArray<string>): string => {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, NAMED_CONTAINERS).join(", ");
  return unique.length > NAMED_CONTAINERS ? `${shown} and ${unique.length - NAMED_CONTAINERS} more` : shown;
};

const remediation = (input: UnrecordedWorkloadEvidence, destroy: string): string => {
  switch (input.app.kind) {
    case "user":
      return `From ${input.root}, run \`lando start\` to reconcile them with the Landofile, or ${destroy} to remove them. Named volumes stay either way.`;
    case "global":
    case "scratch":
      return `Run ${destroy} to remove them. Named volumes stay.`;
  }
};

/**
 * Refuses a root with no applied plan only while workloads may still run there: containers a
 * running runtime reports, recorded containers on a runtime Lando could not check, or a record
 * that does not say what it holds. Retained volumes, recorded networks, and recorded containers a
 * running runtime no longer reports leave the app as if it never started.
 */
export const unrecordedWorkloadRefusal = (input: UnrecordedWorkloadEvidence): AppResolveError | undefined => {
  const found = new Map<string, string[]>();
  for (const group of input.groups) {
    const names = found.get(group.providerId) ?? [];
    for (const service of group.services)
      names.push(service.nativeName ?? service.containerId ?? `${service.service} (app ${service.app})`);
    if (names.length > 0) found.set(group.providerId, names);
  }
  const providers = new Set(found.keys());
  const sentences = [...found].map(
    ([provider, names]) =>
      `The ${provider} runtime has containers for ${input.root} that no applied app state describes: ${named(names)}.`,
  );
  for (const hints of input.ownership) {
    const containers = (hints.members ?? []).filter((member) => member.kind === "container");
    if (hints.members !== undefined && (containers.length === 0 || input.observed.has(hints.providerId)))
      continue;
    providers.add(hints.providerId);
    sentences.push(
      hints.members === undefined
        ? `The ${hints.providerId} ownership record for ${input.root} does not name its resources, and no applied app state describes them.`
        : `Lando recorded containers for ${input.root} that no applied app state describes and could not check the ${hints.providerId} runtime (not running or not answering): ${named(containers.map((member) => member.nativeName))}.`,
    );
  }
  if (sentences.length === 0) return undefined;
  const destroy = [...providers]
    .map((provider) => `\`${destroyCommand(input.app, ProviderId.make(provider))}\``)
    .join(" or ");
  return new AppResolveError({
    message: sentences.join(" "),
    reason: "mismatch",
    detail: "provider-resources",
    remediation: remediation(input, destroy),
  });
};
