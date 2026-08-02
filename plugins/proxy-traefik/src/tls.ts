import { Effect } from "effect";

import type { AppId, RoutePlan } from "@lando/sdk/schema";

import {
  appCertificateFiles,
  certificateDir,
  defaultCertificateFiles,
  defaultCertificateNames,
  defaultTlsFile,
  joinFor,
} from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { type TraefikTlsFiles, renderTraefikDefaultTlsConfig } from "./routing.ts";

const CONTAINER_CERTIFICATE_DIR = "/etc/traefik/dynamic/certs";

export const httpsHostnames = (routes: ReadonlyArray<RoutePlan>): ReadonlyArray<string> =>
  [...new Set(routes.filter((route) => route.scheme !== "http").map((route) => route.hostname))].sort();

export const normalizeDefaultDomain = (defaultDomain: string): string =>
  defaultDomain.trim().toLowerCase().replace(/\.+$/, "");

const copyCertificate = (dependencies: TraefikProxyDependencies, source: string, destination: string) =>
  dependencies.fileSystem
    .readText(source)
    .pipe(Effect.flatMap((content) => dependencies.fileSystem.writeAtomic(destination, content)));

const copyPrivateKey = (dependencies: TraefikProxyDependencies, source: string, destination: string) =>
  dependencies.fileSystem
    .readText(source)
    .pipe(Effect.flatMap((content) => dependencies.fileSystem.writeSecretAtomic(destination, content)));

export const removeAppCertificates = (dependencies: TraefikProxyDependencies, app: AppId) => {
  const files = appCertificateFiles(dependencies.paths, app);
  return Effect.all([dependencies.fileSystem.remove(files.cert), dependencies.fileSystem.remove(files.key)], {
    discard: true,
  });
};

export const ensureTlsFiles = (
  dependencies: TraefikProxyDependencies,
  input: {
    readonly app: AppId;
    readonly defaultDomain: string;
    readonly hostnames: ReadonlyArray<string>;
    readonly refreshAppCertificate: boolean;
  },
): Effect.Effect<TraefikTlsFiles, unknown> =>
  Effect.gen(function* () {
    const defaultFiles = defaultCertificateFiles(dependencies.paths, input.defaultDomain);
    const appFiles = appCertificateFiles(dependencies.paths, input.app);
    yield* dependencies.fileSystem.mkdir(certificateDir(dependencies.paths));

    const hasDefaultCertificate =
      (yield* dependencies.fileSystem.exists(defaultFiles.cert)) &&
      (yield* dependencies.fileSystem.exists(defaultFiles.key));
    if (!hasDefaultCertificate) {
      const issued = yield* dependencies.certificateAuthority.issueCert({
        cn: `*.${input.defaultDomain}`,
        sans: [`*.${input.defaultDomain}`, input.defaultDomain, "traefik.lndo.site"],
      });
      yield* copyCertificate(dependencies, issued.certPath, defaultFiles.cert);
      yield* copyPrivateKey(dependencies, issued.keyPath, defaultFiles.key);
    }

    const defaultNames = defaultCertificateNames(input.defaultDomain);
    yield* dependencies.fileSystem.writeAtomic(
      defaultTlsFile(dependencies.paths),
      renderTraefikDefaultTlsConfig({
        certFile: `${CONTAINER_CERTIFICATE_DIR}/${defaultNames.cert}`,
        keyFile: `${CONTAINER_CERTIFICATE_DIR}/${defaultNames.key}`,
      }),
    );

    const hasAppCertificate =
      (yield* dependencies.fileSystem.exists(appFiles.cert)) &&
      (yield* dependencies.fileSystem.exists(appFiles.key));
    if (input.refreshAppCertificate || !hasAppCertificate) {
      const issued = yield* dependencies.certificateAuthority.issueCert({
        cn: input.hostnames[0] ?? input.defaultDomain,
        sans: input.hostnames,
      });
      yield* copyCertificate(dependencies, issued.certPath, appFiles.cert);
      yield* copyPrivateKey(dependencies, issued.keyPath, appFiles.key);
    }

    const encodedApp = encodeURIComponent(String(input.app));
    return {
      certFile: `${CONTAINER_CERTIFICATE_DIR}/${encodedApp}.crt`,
      keyFile: `${CONTAINER_CERTIFICATE_DIR}/${encodedApp}.key`,
    };
  });

export const removeAllCertificates = (dependencies: TraefikProxyDependencies) =>
  Effect.gen(function* () {
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
