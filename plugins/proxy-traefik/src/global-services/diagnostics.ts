import { Effect, Schema } from "effect";

import { ServiceConfig } from "@lando/sdk/schema";

import {
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  TRAEFIK_DIAGNOSTICS_HOSTNAME,
  TRAEFIK_DIAGNOSTICS_PORT,
  TRAEFIK_DIAGNOSTICS_SOURCE,
} from "../diagnostics.ts";

export const TRAEFIK_DIAGNOSTICS_IMAGE = "nginx:1.26-alpine" as const;

const diagnosticsServiceConfig = Schema.decodeUnknownSync(ServiceConfig)({
  api: 4,
  type: "compose",
  image: TRAEFIK_DIAGNOSTICS_IMAGE,
  appMount: false,
  command: ["nginx", "-c", `${TRAEFIK_DIAGNOSTICS_CONTAINER_DIR}/nginx.conf`, "-g", "daemon off;"],
  mounts: [
    {
      type: "bind",
      source: TRAEFIK_DIAGNOSTICS_SOURCE,
      target: TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
      readOnly: true,
    },
  ],
  endpoints: [{ _tag: "internal", protocol: "http", port: TRAEFIK_DIAGNOSTICS_PORT }],
  hostnames: [TRAEFIK_DIAGNOSTICS_HOSTNAME],
  environment: {},
});

const diagnosticsGlobalService: Effect.Effect<ServiceConfig> = Effect.succeed(diagnosticsServiceConfig);

export default diagnosticsGlobalService;
