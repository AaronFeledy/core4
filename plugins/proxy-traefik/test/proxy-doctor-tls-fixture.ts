import { chmod, mkdir, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { Effect } from "effect";

import type { PluginDoctorReport } from "@lando/sdk/plugins";
import type { AppId, HostPlatform, RoutePlan } from "@lando/sdk/schema";

import { proxyTlsDoctorCheck } from "../src/index.ts";
import {
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  appCertificateFiles,
  certificateDir,
  defaultCertificateFiles,
  defaultCertificateNames,
  defaultTlsFile,
  routeFile,
} from "../src/proxy-paths.ts";
import type { ProxyPaths } from "../src/proxy-types.ts";
import {
  type TraefikTlsFiles,
  renderTraefikDefaultTlsConfig,
  renderTraefikDynamicConfig,
} from "../src/routing.ts";

const currentPlatform = (): HostPlatform => {
  switch (process.platform) {
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "linux";
  }
};

export interface ProxyTlsFixture {
  readonly userDataRoot: string;
  readonly paths: ProxyPaths;
}

export const containerTlsFiles = (certName: string, keyName: string): TraefikTlsFiles => ({
  certFile: posix.join(TRAEFIK_CONTAINER_CERTIFICATE_DIR, certName),
  keyFile: posix.join(TRAEFIK_CONTAINER_CERTIFICATE_DIR, keyName),
});

export const createProxyTlsFixture = async (name: string): Promise<ProxyTlsFixture> => {
  const userDataRoot = await mkdtemp(join(tmpdir(), `lando-proxy-tls-doctor-${name}-`));
  const paths: ProxyPaths = {
    platform: currentPlatform(),
    globalAppRoot: join(userDataRoot, "global"),
  };
  await mkdir(certificateDir(paths), { recursive: true });
  return { userDataRoot, paths };
};

export const removeProxyTlsFixture = (fixture: ProxyTlsFixture): Promise<void> =>
  rm(fixture.userDataRoot, { recursive: true, force: true });

interface HttpsRouteFixture {
  readonly app: AppId;
  readonly routes: ReadonlyArray<RoutePlan>;
  readonly tlsFiles?: TraefikTlsFiles;
}

export const writeHttpsRoute = (fixture: ProxyTlsFixture, route: HttpsRouteFixture): Promise<void> =>
  writeFile(
    routeFile(fixture.paths, route.app),
    renderTraefikDynamicConfig(route.routes, route.app, route.tlsFiles),
    "utf8",
  );

export const writeDefaultTls = async (
  fixture: ProxyTlsFixture,
): Promise<ReturnType<typeof defaultCertificateFiles>> => {
  const files = defaultCertificateFiles(fixture.paths, "lndo.site");
  const names = defaultCertificateNames("lndo.site");
  await Promise.all([
    writeFile(
      defaultTlsFile(fixture.paths),
      renderTraefikDefaultTlsConfig(containerTlsFiles(names.cert, names.key)),
      "utf8",
    ),
    writeFile(files.cert, "default certificate", "utf8"),
    writeFile(files.key, "default key", "utf8"),
  ]);
  return files;
};

export const writeAppTls = async (
  fixture: ProxyTlsFixture,
  app: AppId,
): Promise<ReturnType<typeof appCertificateFiles>> => {
  const files = appCertificateFiles(fixture.paths, app);
  await Promise.all([
    writeFile(files.cert, "app certificate", "utf8"),
    writeFile(files.key, "app key", "utf8"),
  ]);
  return files;
};

export const writeNamedTls = async (
  fixture: ProxyTlsFixture,
  names: { readonly cert: string; readonly key: string },
): Promise<TraefikTlsFiles> => {
  await Promise.all([
    writeFile(join(certificateDir(fixture.paths), names.cert), "app certificate", "utf8"),
    writeFile(join(certificateDir(fixture.paths), names.key), "app key", "utf8"),
  ]);
  return containerTlsFiles(names.cert, names.key);
};

export const symlinkAppTls = async (fixture: ProxyTlsFixture, app: AppId): Promise<TraefikTlsFiles> => {
  const files = appCertificateFiles(fixture.paths, app);
  const targets = {
    cert: join(fixture.userDataRoot, "external.crt"),
    key: join(fixture.userDataRoot, "external.key"),
  };
  await Promise.all([
    writeFile(targets.cert, "external certificate", "utf8"),
    writeFile(targets.key, "external key", "utf8"),
  ]);
  await Promise.all([symlink(targets.cert, files.cert, "file"), symlink(targets.key, files.key, "file")]);
  return containerTlsFiles(basename(files.cert), basename(files.key));
};

export const runProxyTlsDoctorCheck = (
  userDataRoot: string | undefined,
): Promise<ReadonlyArray<PluginDoctorReport>> => {
  return Effect.runPromise(
    proxyTlsDoctorCheck.run({
      providerId: "lando",
      platform: currentPlatform(),
      env: {},
      userDataRoot,
      binDir: undefined,
      stateDir: undefined,
    }),
  );
};

const probeChmodUnreadability = async (): Promise<boolean> => {
  const directory = await mkdtemp(join(tmpdir(), "lando-proxy-tls-doctor-chmod-probe-"));
  const path = join(directory, "probe.key");
  try {
    await writeFile(path, "probe", "utf8");
    const changed = await chmod(path, 0).then(
      () => true,
      () => false,
    );
    if (!changed) return false;
    const handle = await open(path, "r").then(
      (value) => value,
      () => undefined,
    );
    if (handle === undefined) return true;
    await handle.close();
    return false;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

export const chmodMakesUnreadable = await probeChmodUnreadability();
