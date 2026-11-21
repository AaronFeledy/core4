import {
  CONFIG_LINT_UNAVAILABLE_SKIP_LIMIT,
  type ConfigLintSkip,
  type ConfigLintViolation,
  LandofileLayer,
  formatValidationIssuePath,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import type { LoadUnavailableSite } from "./lint-diagnostic.ts";
import { loadFailureViolation } from "./lint-load-failure.ts";
import type { RecordedLoadFailure } from "./load-failures.ts";
import { unavailableEntryPath } from "./validation-path.ts";

export const blockedLoadSkip = ({
  failure,
  recorded,
  context,
}: {
  readonly failure: Parameters<typeof loadFailureViolation>[0];
  readonly recorded: RecordedLoadFailure | undefined;
  readonly context: Parameters<typeof loadFailureViolation>[1];
}): ConfigLintSkip => {
  const error = recorded?.error ?? failure;
  const location: ConfigLintViolation["source"] =
    (recorded?.kind === "local" || recorded?.kind === "missing-content" ? recorded.source : undefined) ??
    (error._tag === "LandofileValidationError" ? error.issues[0]?.source : undefined) ??
    loadFailureViolation(error, context).source;
  const source =
    location !== undefined && "file" in location && Schema.is(LandofileLayer)(location.layer)
      ? { file: location.file, layer: location.layer, path: location.path }
      : undefined;
  if (recorded === undefined) {
    return {
      stage: "resolve",
      reason: "earlier-errors",
      ...(source === undefined ? {} : { source }),
      message: "Resolve checks and final planning did not run because no effective Landofile was available.",
    };
  }
  const cause =
    source === undefined
      ? error._tag
      : `${source.file}${source.path.length === 0 ? "" : ` [${formatValidationIssuePath(source.path)}]`}`;
  return {
    stage: "effective",
    reason: "load-failure",
    ...(source === undefined ? {} : { source }),
    message: `Effective and resolve checks did not run because loading failed at ${cause}.`,
  };
};

export const unavailableEntrySkips = (
  unavailable: readonly LoadUnavailableSite[],
  limit = CONFIG_LINT_UNAVAILABLE_SKIP_LIMIT,
): readonly ConfigLintSkip[] => {
  const skips = new Map<string, ConfigLintSkip>();
  for (const site of unavailable) {
    const path = unavailableEntryPath(site.path);
    const key = JSON.stringify(path);
    if (skips.has(key)) continue;
    skips.set(key, {
      stage: "resolve",
      reason: "unavailable",
      path,
      source: site.source,
      message: "Effective or resolve checks that depend on this entry could not run.",
    });
  }
  const entries = Array.from(skips.values());
  if (entries.length <= limit) return entries;
  const visibleEntries = limit - 1;
  return [
    ...entries.slice(0, visibleEntries),
    {
      stage: "resolve",
      reason: "unavailable",
      message: `${entries.length - visibleEntries} more entries were unavailable.`,
    },
  ];
};
