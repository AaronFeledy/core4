import type { LogSource } from "@lando/sdk/schema";
import type { ServiceBuildStepIntent } from "@lando/sdk/services";

/**
 * Inputs for {@link redirectLogSourceBuildSteps}: the resolved log sources for a
 * service plus the base that produced them. Only a Lando-built (`base: "lando"`)
 * service owns an image build phase, so only it can reify a redirect source.
 */
export interface RedirectLogSourceBuildStepsInput {
  readonly logSources: ReadonlyArray<LogSource>;
  readonly base: "l337" | "lando";
}

/** The redirected fd a stream classification maps to. */
const redirectTarget = (stream: LogSource["stream"]): string =>
  stream === "stdout" ? "/dev/stdout" : "/dev/stderr";

/** The stable build-step id for a redirected source. */
const redirectStepId = (source: LogSource): string => `lando-log-redirect:${String(source.id)}`;

/**
 * Reify `strategy: "redirect"` log sources as deterministic image-build steps.
 *
 * For each redirect source on a Lando-built service the daemon's log path is
 * symlinked to `/dev/stdout` (`stream: "stdout"`) or `/dev/stderr`
 * (`stream: "stderr"`) with `ln -sf` so lines flow through the existing
 * `console` stream with no runtime follower. `ln -sf` is idempotent across
 * rebuilds; the command encodes the source's stream and path so a changed
 * source produces a changed step.
 *
 * A non-Lando base has no build phase to redirect through (redirect sources on
 * such a service are already rejected during {@link mergeLogSources}), so this
 * returns `[]` defensively. `follow` sources are left for the provider to
 * realize inside `RuntimeProvider.logs`.
 */
export const redirectLogSourceBuildSteps = (
  input: RedirectLogSourceBuildStepsInput,
): ServiceBuildStepIntent[] => {
  if (input.base !== "lando") return [];
  return input.logSources
    .filter((source) => source.strategy === "redirect")
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((source) => ({
      id: redirectStepId(source),
      phase: "build",
      command: ["ln", "-sf", redirectTarget(source.stream), String(source.path)],
    }));
};

/**
 * The subset of log sources a runtime follower must realize: only
 * `strategy: "follow"` sources. Redirect sources ride the `console` stream after
 * build-time reification, so they are never followed and never consult the
 * `serviceLogSources` capability.
 */
export const runtimeFollowLogSources = (logSources: ReadonlyArray<LogSource>): LogSource[] =>
  logSources.filter((source) => source.strategy === "follow");
