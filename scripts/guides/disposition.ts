import type { GuidePlatform } from "../../sdk/src/docs/guide-frontmatter.ts";
import type { GuideScenarioAst, GuideScenarioNode, GuideVariant } from "./model.ts";
import { resolveScenario } from "./resolve.ts";

/**
 * The compiler's skip rules for one scenario variant, shared by the generated
 * test and the affected-guide selector so both agree on what will run.
 */
interface ScenarioDisposition {
  /** Scenario layer: `scenario` (test provider) or `e2e` (live provider). */
  readonly layer: string;
  readonly tags: readonly string[];
  /** Rendered reason for the platform rule; the generated test name prints it. */
  readonly platformSkip?: string;
  readonly variantSkip?: { readonly reason: string };
  readonly authoredSkip?: { readonly reason: string };
  /** The effective skip; `undefined` means the variant runs on this host. */
  readonly skip?: { readonly kind: "platform" | "variant" | "authored"; readonly reason: string };
  /** Steps wrapped in `<Skip>`, which are reported as skipped tests. */
  readonly stepSkips: readonly { readonly stepName: string; readonly reason: string }[];
}

export const scenarioDisposition = (
  guide: GuideScenarioAst,
  scenario: GuideScenarioNode,
  requestedVariant: GuideVariant | undefined,
  hostPlatform: GuidePlatform,
): ScenarioDisposition => {
  const resolved = resolveScenario(guide, scenario, requestedVariant);
  const variant = resolved.variant;
  const layer = scenario.layer ?? guide.frontmatter.defaultLayer ?? "scenario";
  const tags = [...new Set([...(variant?.tags ?? guide.frontmatter.tags ?? []), ...(scenario.tags ?? [])])];
  const effectivePlatforms = resolved.platforms;
  const hostPlatforms = hostPlatform === "wsl" ? ["wsl", "linux"] : [hostPlatform];
  const platformMissed =
    effectivePlatforms !== undefined &&
    effectivePlatforms.length > 0 &&
    !hostPlatforms.some((platform) => effectivePlatforms.some((allowed) => allowed === platform));
  const platformSkip = platformMissed
    ? `skipped on ${hostPlatform}: requires platform [${(effectivePlatforms ?? []).join(",")}]`
    : undefined;
  const skip =
    variant?.skip !== undefined
      ? { kind: "variant" as const, reason: variant.skip.reason }
      : platformSkip !== undefined
        ? { kind: "platform" as const, reason: platformSkip }
        : resolved.skipOnly
          ? { kind: "authored" as const, reason: resolved.skipReason }
          : undefined;
  return {
    layer,
    tags,
    ...(platformSkip === undefined ? {} : { platformSkip }),
    ...(variant?.skip === undefined ? {} : { variantSkip: { reason: variant.skip.reason } }),
    ...(resolved.skipOnly ? { authoredSkip: { reason: resolved.skipReason } } : {}),
    ...(skip === undefined ? {} : { skip }),
    stepSkips: resolved.skips,
  };
};
