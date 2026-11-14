import type { AppRouteOwner } from "@lando/sdk/schema";
import { Effect, Redacted } from "effect";
import { renderTraefikDashboardConfig } from "./dashboard.ts";
import { certificateDir, dashboardConfigFile, routeFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import type { RouteReloadSnapshot } from "./route-reload-snapshot.ts";
import { type PreparedRouterTls, removeAppCertificates } from "./tls.ts";

export const publishRoutes = Effect.fn("TraefikRouter.publishRoutes")(function* (
  dependencies: TraefikProxyDependencies,
  input: {
    readonly owner: AppRouteOwner;
    readonly domain: string;
    readonly snapshot: RouteReloadSnapshot & { readonly issuer: string | undefined };
    readonly config: string;
    readonly tls: PreparedRouterTls | undefined;
  },
) {
  const { snapshot, tls } = input;
  const dashboard = renderTraefikDashboardConfig(input.domain);
  if (tls === undefined) {
    yield* removeAppCertificates(dependencies, input.owner);
  } else {
    for (const { files, pair } of [tls.defaults, tls.app]) {
      switch (pair.source) {
        case "reused":
          continue;
        case "issued":
          break;
        default:
          return pair.source satisfies never;
      }
      yield* dependencies.fileSystem.mkdir(certificateDir(dependencies.paths));
      yield* dependencies.fileSystem.writeSecretAtomic(files.key, Redacted.value(pair.privateKey));
      yield* dependencies.fileSystem.writeAtomic(files.cert, pair.certificate);
    }
    if (snapshot.issuer !== tls.issuer.content)
      yield* dependencies.fileSystem.writeAtomic(tls.issuer.file, tls.issuer.content);
    if (snapshot.defaultTlsConfig !== tls.config.content)
      yield* dependencies.fileSystem.writeAtomic(tls.config.file, tls.config.content);
  }
  if (snapshot.dashboardConfig !== dashboard)
    yield* dependencies.fileSystem.writeAtomic(dashboardConfigFile(dependencies.paths), dashboard);
  if (
    snapshot.routeConfig !== input.config ||
    tls?.app.pair.source === "issued" ||
    tls?.defaults.pair.source === "issued"
  )
    yield* dependencies.fileSystem.writeAtomic(routeFile(dependencies.paths, input.owner), input.config);
}, Effect.uninterruptible);
