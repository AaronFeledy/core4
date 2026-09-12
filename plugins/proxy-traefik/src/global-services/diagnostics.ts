import { mkdir, writeFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ServiceConfig } from "@lando/sdk/schema";

import {
  TRAEFIK_DIAGNOSTICS_CONTAINER_DIR,
  TRAEFIK_DIAGNOSTICS_HOSTNAME,
  TRAEFIK_DIAGNOSTICS_PORT,
  TRAEFIK_DIAGNOSTICS_SOURCE,
  renderTraefikDiagnosticHtml,
  renderTraefikDiagnosticNginxConfig,
} from "../diagnostics.ts";
import { diagnosticConfigFile, diagnosticDir, diagnosticHtmlFile } from "../proxy-paths.ts";
import type { TraefikProxyDependencies } from "../proxy-types.ts";
import { writeSecretAtomic } from "../secret-file.ts";

export const prepareTraefikDiagnostics = ({
  fileSystem,
  paths,
}: {
  readonly fileSystem: Pick<TraefikProxyDependencies["fileSystem"], "mkdir" | "writeAtomic">;
  readonly paths: TraefikProxyDependencies["paths"];
}) =>
  Effect.gen(function* () {
    yield* fileSystem.mkdir(diagnosticDir(paths));
    yield* fileSystem.writeAtomic(diagnosticHtmlFile(paths), renderTraefikDiagnosticHtml());
    yield* fileSystem.writeAtomic(diagnosticConfigFile(paths), renderTraefikDiagnosticNginxConfig());
  });

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
  healthcheck: {
    kind: "command",
    command: ["sh", "-c", "wget -q -S -O /dev/null http://127.0.0.1:8080/ 2>&1 | grep -q 'HTTP/1.1 404'"],
    intervalSeconds: 1,
    timeoutSeconds: 2,
    retries: 30,
  },
  environment: {},
});

const diagnosticsGlobalService = Effect.gen(function* () {
  const paths = makeLandoPaths();
  yield* prepareTraefikDiagnostics({
    paths,
    fileSystem: {
      mkdir: (path) => Effect.tryPromise(() => mkdir(path, { recursive: true })).pipe(Effect.asVoid),
      writeAtomic: (path, content) =>
        Effect.tryPromise(() =>
          writeSecretAtomic(path, content, {
            writeFile: (file, bytes) => writeFile(file, bytes, { mode: 0o644 }),
          }),
        ),
    },
  });
  return diagnosticsServiceConfig;
});

export default diagnosticsGlobalService;
