import { lstat, open, readFile, readdir } from "node:fs/promises";

import { makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { Effect } from "effect";

import {
  ROUTE_FILE_PREFIX,
  ROUTE_FILE_SUFFIX,
  TRAEFIK_CONTAINER_CERTIFICATE_DIR,
  certificateDir,
  defaultTlsFile,
  dynamicConfigDir,
  joinFor,
} from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";
import { DEFAULT_AUTHORITY_PORTS, persistedAuthorities } from "./routing.ts";

const readText = (path: string): Effect.Effect<string | undefined> =>
  Effect.tryPromise(() => readFile(path, "utf8")).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const readNames = (path: string): Effect.Effect<ReadonlyArray<string> | undefined> =>
  Effect.tryPromise(() => readdir(path)).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

const isReadableRegularFile = (path: string): Effect.Effect<boolean> =>
  Effect.tryPromise(async () => {
    const metadata = await lstat(path);
    if (!metadata.isFile()) return false;
    const handle = await open(path, "r");
    try {
      return true;
    } finally {
      await handle.close();
    }
  }).pipe(Effect.catchAll(() => Effect.succeed(false)));

const routeToken = (name: string): string | undefined => {
  if (!name.startsWith(ROUTE_FILE_PREFIX) || !name.endsWith(ROUTE_FILE_SUFFIX)) return undefined;
  const token = name.slice(ROUTE_FILE_PREFIX.length, -ROUTE_FILE_SUFFIX.length);
  return token.length === 0 ? undefined : token;
};

const configPath = (content: string, field: "certFile" | "keyFile"): string | undefined => {
  const value = content.match(new RegExp(`^\\s*(?:-\\s*)?${field}:\\s*(.+?)\\s*$`, "mu"))?.[1];
  if (value === undefined) return undefined;
  return value.match(/^(["'])(.*)\1$/u)?.[2] ?? value;
};

const hostCertificatePath = (
  paths: ProxyPaths,
  content: string,
  field: "certFile" | "keyFile",
): string | undefined => {
  const containerPath = configPath(content, field);
  const prefix = `${TRAEFIK_CONTAINER_CERTIFICATE_DIR}/`;
  if (containerPath === undefined || !containerPath.startsWith(prefix)) return undefined;
  const filename = containerPath.slice(prefix.length);
  if (filename.length === 0 || filename.includes("/") || filename.includes("\\")) return undefined;
  return joinFor(paths)(certificateDir(paths), filename);
};

const defaultCertificatePresent = (paths: ProxyPaths, config: string | undefined): Effect.Effect<boolean> => {
  if (config === undefined) return Effect.succeed(false);
  const cert = hostCertificatePath(paths, config, "certFile");
  const key = hostCertificatePath(paths, config, "keyFile");
  if (cert === undefined || key === undefined) return Effect.succeed(false);
  return Effect.zipWith(
    isReadableRegularFile(cert),
    isReadableRegularFile(key),
    (certPresent, keyPresent) => certPresent && keyPresent,
  );
};

const missingAppCertificateCount = (
  paths: ProxyPaths,
  configs: ReadonlyArray<string>,
): Effect.Effect<number> =>
  Effect.forEach(
    configs,
    (config) => {
      const cert = hostCertificatePath(paths, config, "certFile");
      const key = hostCertificatePath(paths, config, "keyFile");
      if (cert === undefined || key === undefined) return Effect.succeed(false);
      return Effect.zipWith(
        isReadableRegularFile(cert),
        isReadableRegularFile(key),
        (certPresent, keyPresent) => certPresent && keyPresent,
      );
    },
    { concurrency: "unbounded" },
  ).pipe(Effect.map((present) => present.filter((value) => !value).length));

interface TlsReportState {
  readonly httpsApps: number;
  readonly defaultConfigPresent: boolean;
  readonly defaultCertificateReady: boolean;
  readonly appsMissingCertificates: number;
}

const tlsReport = (state: TlsReportState): PluginDoctorReport => {
  const ready =
    state.defaultConfigPresent && state.defaultCertificateReady && state.appsMissingCertificates === 0;
  return {
    name: "proxy-tls",
    status: ready ? "pass" : "warn",
    severity: ready ? "info" : "warn",
    runtimeStatus: ready ? "tls-ready" : "tls-material-missing",
    runtime: { running: ready },
    context: {
      proxyId: "traefik",
      httpsApps: String(state.httpsApps),
      defaultTlsConfig: state.defaultConfigPresent ? "present" : "missing",
      defaultCertificate: state.defaultCertificateReady ? "present" : "missing",
      appsMissingCertificates: String(state.appsMissingCertificates),
    },
    solutions: ready
      ? []
      : [
          {
            kind: "manual",
            description: "Run setup to restore the proxy TLS material.",
            command: "lando setup",
          },
          {
            kind: "manual",
            description: "Ensure an active CertificateAuthority plugin is configured, then run setup again.",
          },
        ],
  };
};

export const proxyTlsDoctorCheck: PluginDoctorCheckContribution = {
  id: "proxy-tls",
  run: ({ userDataRoot, platform }) => {
    if (userDataRoot === undefined) return Effect.succeed([]);
    const resolved = makeLandoPaths({ userDataRoot, platform });
    const paths: ProxyPaths = { platform: resolved.platform, globalAppRoot: resolved.globalAppRoot };
    return Effect.gen(function* () {
      const names = yield* readNames(dynamicConfigDir(paths));
      if (names === undefined) return [];
      const httpsConfigs = yield* Effect.forEach(
        names,
        (name) => {
          if (routeToken(name) === undefined) return Effect.succeed(undefined);
          return readText(joinFor(paths)(dynamicConfigDir(paths), name)).pipe(
            Effect.map((content) =>
              content !== undefined &&
              persistedAuthorities(content, DEFAULT_AUTHORITY_PORTS).some(
                (authority) => authority.scheme === "https",
              )
                ? content
                : undefined,
            ),
          );
        },
        { concurrency: "unbounded" },
      ).pipe(Effect.map((apps) => apps.filter((app): app is string => app !== undefined)));
      if (httpsConfigs.length === 0) return [];

      const defaultConfig = yield* readText(defaultTlsFile(paths));
      const defaultCertificateReady = yield* defaultCertificatePresent(paths, defaultConfig);
      const appsMissingCertificates = yield* missingAppCertificateCount(paths, httpsConfigs);
      return [
        tlsReport({
          httpsApps: httpsConfigs.length,
          defaultConfigPresent: defaultConfig !== undefined,
          defaultCertificateReady,
          appsMissingCertificates,
        }),
      ];
    });
  },
};
