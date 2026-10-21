export { HostEventAppStatus } from "@lando/engine/operations/app-config-result";
import type { HostEventAppStatus } from "@lando/engine/operations/app-config-result";

import { makeLandoPaths } from "@lando/paths";
import { LANDO_HOST_EVENT_ENV, type LandofileEvents } from "@lando/sdk/schema";

import { isExcludedFromUserAppDefaults } from "@lando/engine/planner/app-defaults";
import {
  compileEffectiveEvents,
  hostEventStatusesForApp,
  stampPlanServices,
} from "@lando/engine/planner/effective-events";
import { loadGlobalConfigSync } from "@lando/engine/services/config";

export interface HostEventPlanInput {
  readonly name: string;
  readonly root: string;
  readonly services: Readonly<Record<string, { readonly primary?: boolean }>>;
  readonly events?: LandofileEvents;
}

export const hostEventStatusesForPlan = (plan: HostEventPlanInput): ReadonlyArray<HostEventAppStatus> => {
  const paths = makeLandoPaths();
  if (
    isExcludedFromUserAppDefaults(plan.name, plan.root, {
      globalAppRoot: paths.globalAppRoot,
      scratchDir: paths.scratchDir,
    })
  ) {
    return [];
  }
  const hostEvents = loadGlobalConfigSync().hostEvents;
  if (hostEvents === undefined) return [];
  return hostEventStatusesForApp(
    compileEffectiveEvents({
      landofile: plan.events === undefined ? {} : { events: plan.events },
      hostEvents,
      services: stampPlanServices(plan.services),
      skipHostEvents: process.env[LANDO_HOST_EVENT_ENV] === "1",
    }),
  );
};

export const renderHostEventStatuses = (statuses: ReadonlyArray<HostEventAppStatus>): ReadonlyArray<string> =>
  statuses.map((entry) => {
    const reason = entry.reason === undefined ? "" : ` (${entry.reason})`;
    return `hostEvents.${entry.event}[${entry.index}]\t${entry.status}${reason}`;
  });
