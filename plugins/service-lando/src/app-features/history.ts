import { Effect } from "effect";

import {
  HISTORY_DEFAULT_SERVICE_TYPES,
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  historyStoreName,
  shouldAttachHistoryVolume,
} from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { LANDO_BOOT_FEATURE_ID } from "../features/boot.ts";
import { appNameFor } from "../app-name.ts";

export { HISTORY_FEATURE_ID };

export const historyVolumeFeature: AppFeatureDefinition = {
  id: HISTORY_FEATURE_ID,
  priority: 100,
  activatedBy: { services: { hasFeature: LANDO_BOOT_FEATURE_ID } },
  selectors: {
    types: [...HISTORY_DEFAULT_SERVICE_TYPES],
    hasFeature: [LANDO_BOOT_FEATURE_ID],
  },
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
          target: HISTORY_MOUNT_TARGET,
          readOnly: false,
        });
      });
    }),
  ),
};
