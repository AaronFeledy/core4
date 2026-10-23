export const ROUTE_OWNER_KEY_PREFIX = "# lando.owner-key: ";

export const routeOwnerKeyComment = (ownerKey: string): string => `${ROUTE_OWNER_KEY_PREFIX}${ownerKey}\n`;

export const ownerKeyFromRouteConfig = (content: string): string | undefined => {
  for (const line of content.split("\n").slice(0, 16)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(ROUTE_OWNER_KEY_PREFIX)) continue;
    const value = trimmed.slice(ROUTE_OWNER_KEY_PREFIX.length).trim();
    if (value.length > 0) return value;
  }
  return undefined;
};
