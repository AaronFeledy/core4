/**
 * Canonical `dev.lando.*` label keys.
 *
 * Volume ownership and storage class keys stay defined in their producer
 * modules. This file re-exports them so callers have one import path.
 */
import type { AppPlan } from "@lando/sdk/schema";

export { STORAGE_KIND_LABEL, STORAGE_SCOPE_LABEL } from "./volume-classes.ts";
export { VOLUME_OWNER_LABEL, VOLUME_SELECTOR_LABEL } from "./volume-ownership.ts";

export const APP_LABEL = "dev.lando.app" as const;
export const APP_ROOT_LABEL = "dev.lando.app-root" as const;
export const SERVICE_LABEL = "dev.lando.service" as const;
export const PROVIDER_LABEL = "dev.lando.provider" as const;
export const STORE_LABEL = "dev.lando.store" as const;
export const VOLUME_SNAPSHOT_LABEL = "dev.lando.volume-snapshot" as const;
export const SNAPSHOT_ID_LABEL = "dev.lando.snapshot-id" as const;
export const SNAPSHOT_STORE_LABEL = "dev.lando.snapshot-store" as const;
export const VOLUME_INSTANCE_LABEL = "dev.lando.volume-instance" as const;
export const SCRATCH_LABEL = "dev.lando.scratch" as const;
export const SCRATCH_ID_LABEL = "dev.lando.scratch-id" as const;
export const AGENT_SESSION_LABEL = "dev.lando.agent-session" as const;
export const HOST_PROXY_SESSION_LABEL = "dev.lando.host-proxy-session" as const;

export const scratchLabelsForPlan = (plan: AppPlan): Record<string, string> => {
  const scratch = plan.extensions["@lando/core/scratch"];
  const scratchId = typeof scratch === "object" && scratch !== null ? Reflect.get(scratch, "id") : undefined;
  return scratchId === plan.id && typeof scratchId === "string"
    ? { [SCRATCH_LABEL]: "TRUE", [SCRATCH_ID_LABEL]: scratchId }
    : {};
};
