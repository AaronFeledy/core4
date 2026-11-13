import { appIdentityKey } from "@lando/sdk/schema";
import {
  APP_LABEL,
  APP_ROOT_LABEL,
  PROVIDER_LABEL,
  ROLE_LABEL,
  SCRATCH_ID_LABEL,
  SCRATCH_LABEL,
  SERVICE_LABEL,
} from "./labels.ts";
import { isOwnershipRoot } from "./ownership-root.ts";

/** The observed or inspected identity a service-container ownership decision is made against. */
export interface ServiceContainerIdentity {
  readonly app: string;
  readonly appRoot: string;
  readonly service: string;
  readonly providerId: string;
}

const scratchMarkersCoherent = (labels: Readonly<Record<string, string>>, app: string): boolean => {
  const scratch = labels[SCRATCH_LABEL];
  const scratchId = labels[SCRATCH_ID_LABEL];
  return (scratch === undefined && scratchId === undefined) || (scratch === "TRUE" && scratchId === app);
};

/**
 * The one native-label predicate that authorizes mutating a service container: `undefined` when
 * every ownership label proves `identity`, otherwise the first label that is missing or disagrees.
 *
 * A service container must carry its app, root, and service; its provider and owner labels may be
 * absent but never contradict the acting provider or the identity key derived from the root; role
 * helpers never qualify; and scratch markers are absent or TRUE with the app's own scratch id.
 */
export const serviceContainerOwnershipProblem = (
  labels: Readonly<Record<string, string>> | undefined,
  identity: ServiceContainerIdentity,
): string | undefined => {
  if (labels === undefined || Object.keys(labels).length === 0) return APP_LABEL;
  const app = labels[APP_LABEL];
  if (app === undefined || identity.app.length === 0 || app !== identity.app) return APP_LABEL;
  const appRoot = labels[APP_ROOT_LABEL];
  if (
    appRoot === undefined ||
    !isOwnershipRoot(appRoot) ||
    identity.appRoot.length === 0 ||
    appRoot !== identity.appRoot
  )
    return APP_ROOT_LABEL;
  const service = labels[SERVICE_LABEL];
  if (service === undefined || identity.service.length === 0 || service !== identity.service)
    return SERVICE_LABEL;
  if (labels[ROLE_LABEL] !== undefined) return ROLE_LABEL;
  const legacy = labels["com.lando.app"];
  if (legacy !== undefined && legacy !== app) return "com.lando.app";
  if (labels[PROVIDER_LABEL] !== undefined && labels[PROVIDER_LABEL] !== identity.providerId)
    return PROVIDER_LABEL;
  if (
    labels["dev.lando.owner"] !== undefined &&
    labels["dev.lando.owner"] !== appIdentityKey("owner", appRoot)
  )
    return "dev.lando.owner";
  return scratchMarkersCoherent(labels, app) ? undefined : SCRATCH_LABEL;
};

/** Native labels, rather than projected observation fields, authorize a service-container mutation. */
export const serviceContainerOwnershipLabels = (
  labels: Readonly<Record<string, string>> | undefined,
  identity: ServiceContainerIdentity,
): boolean => serviceContainerOwnershipProblem(labels, identity) === undefined;
