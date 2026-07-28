import type { AppPlan, LandofileShape } from "@lando/core/schema";

export class ComposeFixtureOutcomeError extends Error {
  override readonly name = "ComposeFixtureOutcomeError";
}

export type OutcomeContext = {
  readonly appRoot: string;
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
};

export const valueAt = (value: unknown, path: string): unknown => {
  let current = value;
  for (const segment of path.replaceAll(/\[(\d+)\]/gu, ".$1").split(".")) {
    if (
      segment.length === 0 ||
      (typeof current !== "object" && typeof current !== "function") ||
      current === null
    ) {
      return undefined;
    }
    current = Reflect.get(current, segment);
  }
  return current;
};

export const fixtureEnvEntry = (service: string, index: number): readonly [string, string] => [
  `US476_${service.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_${index}`,
  `fixture-${index}`,
];
