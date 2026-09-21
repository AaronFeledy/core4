import { expect } from "bun:test";

import type { ServicePlan } from "@lando/sdk/schema";

import { LANDO_ERROR_PAGES_BUILD_STEP_ID } from "../../src/services/http-errors.ts";

interface PlannedBuildStep {
  readonly id?: string;
  readonly user?: string;
  readonly command: string | ReadonlyArray<string>;
}

/**
 * Proves the shared 403/404 pages reach the image through the one build step
 * every Lando-owned web server installs, rather than through a launcher write.
 */
export const expectSharedErrorPagesBuildStep = (plan: ServicePlan): void => {
  const features = plan.extensions["@lando/core/service-features"] as
    | { readonly buildSteps?: ReadonlyArray<PlannedBuildStep> }
    | undefined;
  const step = features?.buildSteps?.find((candidate) => candidate.id === LANDO_ERROR_PAGES_BUILD_STEP_ID);
  expect(step).toBeDefined();
  expect(step?.user).toBe("root");
  const command = JSON.stringify(step?.command);
  expect(command).toContain("/usr/share/lando/errors/403.html");
  expect(command).toContain("/usr/share/lando/errors/404.html");
};
