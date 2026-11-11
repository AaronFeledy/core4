import { AppId, type AppRouteOwner, appIdentityKey } from "@lando/sdk/schema";

export const routeOwner = (id: string, identitySource: string = id): AppRouteOwner => ({
  id: AppId.make(id),
  ownerKey: appIdentityKey("owner", identitySource),
});

export const routeObjectName = (owner: AppRouteOwner, index: number): string =>
  `route-${owner.ownerKey}-${encodeURIComponent(owner.id)}-${index}`;

export const routeFileBasename = (owner: AppRouteOwner): string => `routes-${owner.ownerKey}.yml`;

export const routeMetadataLine = (owner: AppRouteOwner): string =>
  `# lando-route-file: ${JSON.stringify({ version: 1, app: owner.id })}`;
