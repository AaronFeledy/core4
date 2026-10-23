export const ROUTE_OWNER_KEY_PREFIX = "# lando.owner-key: ";
const ROUTE_OWNER_KEY = /^[0-9a-f]{64}$/;

export const routeOwnerKeyComment = (ownerKey: string): string => `${ROUTE_OWNER_KEY_PREFIX}${ownerKey}\n`;

export const ownerKeyFromRouteConfig = (content: string): string | undefined => {
  const line = content.split("\n", 1)[0] ?? "";
  if (!line.startsWith(ROUTE_OWNER_KEY_PREFIX)) return undefined;
  const value = line.slice(ROUTE_OWNER_KEY_PREFIX.length);
  return ROUTE_OWNER_KEY.test(value) ? value : undefined;
};
