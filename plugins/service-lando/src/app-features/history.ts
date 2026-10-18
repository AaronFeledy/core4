import { Effect } from "effect";

import {
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  PortablePath,
  historyStoreName,
  shouldAttachHistoryVolume,
} from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { appNameFor } from "../app-name.ts";

export { HISTORY_FEATURE_ID };

const historyMountTarget = PortablePath.make(HISTORY_MOUNT_TARGET);

export const historyVolumeFeature: AppFeatureDefinition = {
  id: HISTORY_FEATURE_ID,
  // Empty activatedBy.services matches every service and satisfies the loader
  // guard without adding cycle edges (hasExplicitTrigger is type/hasFeature).
  // No selectors: empty-match would throw for apps whose types are not
  // compose or default-history, and would ignore `history: true` on those
  // services. apply still filters with shouldAttachHistoryVolume.
  activatedBy: { services: {} },
  priority: 110,
  apply: Effect.fn("HistoryVolumeFeature.apply")((ctx) =>
    Effect.sync(() => {
      const store = historyStoreName(appNameFor(ctx));
      const attached = new Set<string>();
      ctx.forEachSelected((service) => {
        if (
          !shouldAttachHistoryVolume({
            serviceType: service.service.serviceType,
            history: service.service.normalizedConfig.history,
          })
        ) {
          return;
        }
        if (attached.has(service.service.serviceName)) return;
        attached.add(service.service.serviceName);
        if (
          (service.service.normalizedConfig.storage ?? []).some(
            (entry) => (typeof entry === "string" ? entry : entry.target) === HISTORY_MOUNT_TARGET,
          )
        ) {
          return;
        }
        service.addStorage({
          store,
          target: historyMountTarget,
          readOnly: false,
        });
      });
    }),
  ),
};
