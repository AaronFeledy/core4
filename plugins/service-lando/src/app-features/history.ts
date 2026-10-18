import { Effect } from "effect";

import {
  HISTORY_DEFAULT_SERVICE_TYPES,
  HISTORY_FEATURE_ID,
  HISTORY_MOUNT_TARGET,
  PortablePath,
  historyStoreName,
  shouldAttachHistoryVolume,
} from "@lando/sdk/schema";
import type { AppFeatureDefinition } from "@lando/sdk/services";

import { appNameFor } from "../app-name.ts";
import { LANDO_BOOT_FEATURE_ID } from "../features/boot.ts";
import { COMPOSE_FEATURE_ID } from "../services/compose.ts";

export { HISTORY_FEATURE_ID };

const historyMountTarget = PortablePath.make(HISTORY_MOUNT_TARGET);

export const historyVolumeFeature: AppFeatureDefinition = {
  id: HISTORY_FEATURE_ID,
  // No activatedBy: an explicit boot trigger cycles with php.db-client wiring.
  priority: 110,
  selectors: {
    types: [...HISTORY_DEFAULT_SERVICE_TYPES],
    hasFeature: [LANDO_BOOT_FEATURE_ID, COMPOSE_FEATURE_ID],
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
          target: historyMountTarget,
          readOnly: false,
        });
      });
    }),
  ),
};
