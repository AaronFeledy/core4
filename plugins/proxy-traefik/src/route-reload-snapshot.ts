import type { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import {
  appCertificateFiles,
  dashboardConfigFile,
  defaultCertificateFiles,
  defaultTlsFile,
  routeFile,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";

export const readOptional = (dependencies: TraefikProxyDependencies, path: string) =>
  dependencies.fileSystem
    .exists(path)
    .pipe(
      Effect.flatMap((exists) =>
        exists ? dependencies.fileSystem.readText(path) : Effect.succeed(undefined),
      ),
    );

export const routeReloadSnapshot = (
  dependencies: TraefikProxyDependencies,
  app: AppId,
  defaultDomain: string,
) => {
  const certificates = appCertificateFiles(dependencies.paths, app);
  const defaults = defaultCertificateFiles(dependencies.paths, defaultDomain);
  return Effect.all([
    readOptional(dependencies, routeFile(dependencies.paths, app)),
    readOptional(dependencies, certificates.cert),
    readOptional(dependencies, certificates.key),
    readOptional(dependencies, defaults.cert),
    readOptional(dependencies, defaults.key),
    readOptional(dependencies, defaultTlsFile(dependencies.paths)),
    readOptional(dependencies, dashboardConfigFile(dependencies.paths)),
  ]);
};
