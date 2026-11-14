import { type AppRouteOwner, type RoutePlan, certificateNameForHostname } from "@lando/sdk/schema";
import { Effect, Redacted } from "effect";

import {
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  appCertificateFiles,
  certificateDir,
  defaultCertificateFiles,
  defaultCertificateNames,
  defaultIssuerFile,
  defaultTlsFile,
  joinFor,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { readOptional } from "./route-reload-snapshot.ts";
import { renderTraefikDefaultTlsConfig } from "./routing.ts";

export const httpsHostnames = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<string> => {
  // HTTPS leaf SANs use certificate-coverable names: leftmost partial wildcards
  // map to *.<rest>; deep wildcards (HTTP-only after plan validation) are skipped.
  const byLower = new Map<string, string>();
  for (const route of routes) {
    if (route.scheme === "http") continue;
    const name = certificateNameForHostname(route.hostname);
    if (name === undefined) continue;
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, name);
  }
  return [...byLower.values()].sort(
    (left, right) =>
      Number(left.startsWith("*.")) - Number(right.startsWith("*.")) ||
      left.localeCompare(right, "en", { sensitivity: "base" }),
  );
};

export const normalizeDefaultDomain = (defaultDomain: string): string =>
  defaultDomain.trim().toLowerCase().replace(/\.+$/, "");

export const defaultCertificateHostnames = (domain: string): ReadonlyArray<string> => [
  `*.${domain}`,
  domain,
  `traefik.${domain}`,
];

export const removeAppCertificates = (dependencies: TraefikProxyDependencies, owner: AppRouteOwner) => {
  const files = appCertificateFiles(dependencies.paths, owner);
  return Effect.all(
    [
      Effect.uninterruptible(dependencies.fileSystem.remove(files.cert)),
      Effect.uninterruptible(dependencies.fileSystem.remove(files.key)),
    ],
    { discard: true },
  );
};

export const prepareTlsFiles = Effect.fn("TraefikRouter.prepareTlsFiles")(function* (
  dependencies: TraefikProxyDependencies,
  input: {
    readonly owner: AppRouteOwner;
    readonly defaultDomain: string;
    readonly hostnames: ReadonlyArray<string>;
    readonly refreshAppCertificate: boolean;
    readonly refreshDefaultCertificate: boolean;
    readonly root: string;
  },
) {
  const defaultFiles = defaultCertificateFiles(dependencies.paths, input.defaultDomain);
  const appFiles = appCertificateFiles(dependencies.paths, input.owner);
  const defaultPair = input.refreshDefaultCertificate
    ? yield* dependencies.certificateAuthority.issueCert({
        cn: `*.${input.defaultDomain}`,
        sans: defaultCertificateHostnames(input.defaultDomain),
      })
    : undefined;
  const appPair = input.refreshAppCertificate
    ? yield* dependencies.certificateAuthority.issueCert({
        cn: input.hostnames[0] ?? input.defaultDomain,
        sans: input.hostnames,
      })
    : undefined;
  const issuerFile = defaultIssuerFile(dependencies.paths, input.defaultDomain);
  const issuer = defaultPair?.root.certificate ?? input.root;
  const previousIssuer = yield* readOptional(dependencies, issuerFile);
  const defaultNames = defaultCertificateNames(input.defaultDomain);
  const tlsFile = defaultTlsFile(dependencies.paths);
  const config = renderTraefikDefaultTlsConfig({
    certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.cert}`,
    keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.key}`,
  });
  const previousConfig = yield* readOptional(dependencies, tlsFile);

  return {
    appCertificate: appPair?.certificate,
    defaultCertificate: defaultPair?.certificate,
    publish: Effect.gen(function* () {
      if (defaultPair !== undefined || appPair !== undefined) {
        yield* dependencies.fileSystem.mkdir(certificateDir(dependencies.paths));
      }
      for (const [files, issued] of [
        [defaultFiles, defaultPair],
        [appFiles, appPair],
      ] as const) {
        if (issued === undefined) continue;
        yield* dependencies.fileSystem.writeSecretAtomic(files.key, Redacted.value(issued.privateKey));
        yield* dependencies.fileSystem.writeAtomic(files.cert, issued.certificate);
      }
      if (previousIssuer !== issuer) yield* dependencies.fileSystem.writeAtomic(issuerFile, issuer);
      if (previousConfig !== config) yield* dependencies.fileSystem.writeAtomic(tlsFile, config);
    }),
  };
});

export const removeAllCertificates = Effect.fnUntraced(function* (dependencies: TraefikProxyDependencies) {
  const directory = certificateDir(dependencies.paths);
  if (!(yield* dependencies.fileSystem.exists(directory))) return;
  const files = yield* dependencies.fileSystem.readDir(directory);
  yield* Effect.forEach(
    files,
    (file) => dependencies.fileSystem.remove(joinFor(dependencies.paths)(directory, file)),
    { discard: true },
  );
  yield* dependencies.fileSystem.remove(directory);
});
