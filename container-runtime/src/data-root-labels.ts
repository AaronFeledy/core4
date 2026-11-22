import { sameRealpath } from "@lando/paths";
import {
  LANDO_DATA_ROOT_LABEL,
  LANDO_NETWORK_ROLE_LABEL,
  LANDO_SHARED_NETWORK_ROLE,
  landoSharedCrossAppNetworkName,
} from "@lando/sdk/schema";

export const dataRootLabels = (dataRoot: string | undefined): Readonly<Record<string, string>> =>
  dataRoot === undefined ? {} : { [LANDO_DATA_ROOT_LABEL]: dataRoot };

export const matchesDataRoot = (
  observed: string | undefined,
  expected: string | undefined,
  recorded: boolean,
): boolean => (observed === undefined ? recorded || expected === undefined : observed === expected);

export const inventoryDataRoot = (
  observed: string | undefined,
  recorded: string | undefined,
  local: string | undefined,
): string | undefined =>
  recorded ??
  (observed !== undefined && local !== undefined && sameRealpath(observed, local) ? observed : undefined);

export const sharedNetworkLabels = (dataRoot: string): Readonly<Record<string, string>> => ({
  ...dataRootLabels(dataRoot),
  [LANDO_NETWORK_ROLE_LABEL]: LANDO_SHARED_NETWORK_ROLE,
});

export const ownsSharedCrossAppNetwork = (
  dataRoot: string,
  name: string | undefined,
  labels: Readonly<Record<string, string>> | null | undefined,
): boolean =>
  name === landoSharedCrossAppNetworkName(dataRoot) &&
  labels?.[LANDO_DATA_ROOT_LABEL] === dataRoot &&
  labels[LANDO_NETWORK_ROLE_LABEL] === LANDO_SHARED_NETWORK_ROLE;
