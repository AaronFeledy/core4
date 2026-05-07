/**
 * Global config Effect Schema.
 *
 * The canonical schema lives in `@lando/sdk/schema` (`GlobalConfig`). This
 * file is the place to add core-private decoders (env-var unmarshalling,
 * defaults, platform-specific path resolution) that aren't part of the
 * public schema.
 */
export { GlobalConfig } from "@lando/sdk/schema";
