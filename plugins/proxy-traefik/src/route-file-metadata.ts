import { AppId } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

import { ROUTE_FILE_PREFIX, ROUTE_FILE_SUFFIX } from "./proxy-paths.ts";

export const ROUTE_FILE_METADATA_PREFIX = "# lando-route-file: ";

export const OWNER_ROUTE_KEY_PATTERN = /^[0-9a-f]{64}$/u;

export const RouteFileMetadata = Schema.Struct({
  version: Schema.Literal(1),
  app: AppId,
});
export type RouteFileMetadata = typeof RouteFileMetadata.Type;

const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(RouteFileMetadata));

export const isRouteFileName = (name: string): boolean =>
  name.startsWith(ROUTE_FILE_PREFIX) && name.endsWith(ROUTE_FILE_SUFFIX);

export const isOwnerRouteFileName = (name: string): boolean => {
  if (!isRouteFileName(name)) return false;
  const token = name.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length);
  return OWNER_ROUTE_KEY_PATTERN.test(token);
};

export const renderRouteFileMetadata = (app: AppId): string =>
  `${ROUTE_FILE_METADATA_PREFIX}${JSON.stringify({ version: 1 as const, app: String(app) })}`;

export const parseRouteFileMetadata = (content: string): RouteFileMetadata | undefined => {
  const line = content.split("\n", 1)[0] ?? "";
  if (!line.startsWith(ROUTE_FILE_METADATA_PREFIX)) return undefined;
  const payload = line.slice(ROUTE_FILE_METADATA_PREFIX.length);
  return Option.getOrUndefined(decodeMetadata(payload));
};

export const isOwnerLayoutRouteFile = (name: string, content: string): boolean =>
  isOwnerRouteFileName(name) && parseRouteFileMetadata(content) !== undefined;
