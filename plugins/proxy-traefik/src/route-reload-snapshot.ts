import type { AppRouteOwner } from "@lando/sdk/schema";
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
  owner: AppRouteOwner,
  defaultDomain: string,
) => {
  const certificates = appCertificateFiles(dependencies.paths, owner);
  const defaults = defaultCertificateFiles(dependencies.paths, defaultDomain);
  return Effect.all({
    routeConfig: readOptional(dependencies, routeFile(dependencies.paths, owner)),
    certificate: readOptional(dependencies, certificates.cert),
    privateKey: readOptional(dependencies, certificates.key),
    defaultCertificate: readOptional(dependencies, defaults.cert),
    defaultPrivateKey: readOptional(dependencies, defaults.key),
    defaultTlsConfig: readOptional(dependencies, defaultTlsFile(dependencies.paths)),
    dashboardConfig: readOptional(dependencies, dashboardConfigFile(dependencies.paths)),
  });
};

export type RouteReloadSnapshot = Effect.Success<ReturnType<typeof routeReloadSnapshot>>;

export const servedSnapshotValues = (snapshot: RouteReloadSnapshot) => [
  snapshot.routeConfig,
  snapshot.certificate,
  snapshot.privateKey,
  snapshot.defaultCertificate,
  snapshot.defaultPrivateKey,
  snapshot.defaultTlsConfig,
  snapshot.dashboardConfig,
];
