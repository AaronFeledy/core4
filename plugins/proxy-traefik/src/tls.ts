import { prepareCertificatePair } from "@lando/sdk/certificates";
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
import type { RouteReloadSnapshot } from "./route-reload-snapshot.ts";
import { routeReloadDigest } from "./route-reload-state.ts";
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
    readonly snapshot: RouteReloadSnapshot;
    readonly root: string;
  },
) {
  const defaultFiles = defaultCertificateFiles(dependencies.paths, input.defaultDomain);
  const appFiles = appCertificateFiles(dependencies.paths, input.owner);
  const existingPair = (certificate: string | undefined, privateKey: string | undefined) =>
    certificate === undefined || privateKey === undefined
      ? {}
      : { existing: { certificate, privateKey: Redacted.make(privateKey) } };
  const defaultPair = yield* prepareCertificatePair(dependencies.certificateAuthority, {
    spec: {
      cn: `*.${input.defaultDomain}`,
      sans: defaultCertificateHostnames(input.defaultDomain),
    },
    root: input.root,
    subject: "router default certificate",
    ...existingPair(input.snapshot.defaultCertificate, input.snapshot.defaultPrivateKey),
  });
  const appPair = yield* prepareCertificatePair(dependencies.certificateAuthority, {
    spec: {
      cn: input.hostnames[0] ?? input.defaultDomain,
      sans: input.hostnames,
    },
    root: input.root,
    subject: `router owner ${input.owner.id}`,
    ...existingPair(input.snapshot.certificate, input.snapshot.privateKey),
  });
  const issuerFile = defaultIssuerFile(dependencies.paths, input.defaultDomain);
  const issuer = defaultPair.root;
  const defaultNames = defaultCertificateNames(input.defaultDomain);
  const tlsFile = defaultTlsFile(dependencies.paths);
  const config = renderTraefikDefaultTlsConfig({
    certFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.cert}`,
    keyFile: `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/${defaultNames.key}`,
  });
  return {
    app: { files: appFiles, pair: appPair },
    defaults: { files: defaultFiles, pair: defaultPair },
    issuer: { file: issuerFile, content: issuer },
    config: { file: tlsFile, content: config },
    generation: routeReloadDigest([appPair.certificate, defaultPair.certificate]),
  };
});

export type PreparedRouterTls = Effect.Success<ReturnType<typeof prepareTlsFiles>>;

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
