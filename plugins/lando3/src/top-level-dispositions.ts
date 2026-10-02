import type { ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { Lando3Path, MergedLegacyValue } from "./contract.ts";
import { occurrencesAt } from "./legacy-merge.ts";
import { makeReport } from "./lowering-report.ts";
import { spanOf } from "./service-diagnostics.ts";
import { formatPath } from "./source.ts";

type Disposition = {
  readonly kind: "dropped" | "needs-review" | "unsupported";
  readonly message: string;
  readonly remediation: string;
};

const managed: Disposition = {
  kind: "dropped",
  message: "This Lando 3 global setting is not imported from a Landofile.",
  remediation: "Remove this setting; Lando 4 manages this itself. Conversion never writes global config.",
};
const runtime: Disposition = {
  kind: "dropped",
  message: "This is runtime state Lando 3 computes each run, not lowered configuration or CLI history.",
  remediation: "Remove this runtime state from the Landofile.",
};
const custom: Disposition = {
  kind: "needs-review",
  message: "Names custom Lando 3 Landofile basenames",
  remediation:
    "Rename the files to the standard Lando 4 basenames before converting; custom Landofile names are not honored.",
};
const registry: Disposition = {
  kind: "unsupported",
  message: "Private plugin registry configuration cannot be converted.",
  remediation:
    "Private plugin registries are not supported by Lando 4 in this release; install plugins from a public source, or keep the app on Lando 3.",
};
const equivalent = (target: string): Disposition => ({
  kind: "dropped",
  message: "This Lando 3 global setting is not imported from a Landofile.",
  remediation: `Configure ${target} explicitly; conversion never reads or writes global config.`,
});
const globalMap = (key: string, serviceKey: string): Disposition => ({
  kind: "dropped",
  message: `Lando 3 read ${key} only from global config; the converter never imports global state.`,
  remediation: `Configure Lando 4 global config ${key}, or per-service ${serviceKey}, explicitly.`,
});

export const TOP_LEVEL_DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  landoFile: custom,
  preLandoFiles: custom,
  postLandoFiles: custom,
  domain: equivalent("Lando 4 global config proxy.defaultDomain"),
  bindAddress: equivalent("Lando 4 global config router.bindAddress"),
  proxyBindAddress: equivalent("Lando 4 global config router.bindAddress"),
  proxyHttpPort: equivalent("Lando 4 router settings for HTTP ports"),
  proxyHttpsPort: equivalent("Lando 4 router settings for HTTPS ports"),
  proxyHttpFallbacks: equivalent("Lando 4 router settings for HTTP port fallbacks"),
  proxyHttpsFallbacks: equivalent("Lando 4 router settings for HTTPS port fallbacks"),
  proxyName: managed,
  proxyPassThru: managed,
  proxyDefaultCert: managed,
  proxyDefaultKey: managed,
  proxyCache: managed,
  proxyCommand: managed,
  proxyCustom: managed,
  networkBridge: managed,
  networkLimit: managed,
  engineConfig: managed,
  dockerBin: managed,
  orchestratorVersion: managed,
  orchestratorBin: managed,
  composeBin: managed,
  orchestratorSeparator: managed,
  dockerSupportedVersions: managed,
  appEnv: globalMap("appEnv", "environment"),
  appLabels: globalMap("appLabels", "labels"),
  maxKeyWarning: managed,
  disablePlugins: managed,
  pluginConfig: registry,
  pluginConfigFile: registry,
  experimental: managed,
  alliance: managed,
  setup: managed,
  channel: equivalent("lando4 update --channel stable|next|dev"),
  stats: equivalent("Lando 4 global config telemetry.enabled"),
  logLevel: equivalent("Lando 4 global config logLevel"),
  logLevelConsole: equivalent("Lando 4 logLevel or --log-level"),
  logDir: managed,
  mode: managed,
  isInteractive: runtime,
  userAgent: runtime,
  proxyContainer: runtime,
  proxyNet: runtime,
  proxyDir: runtime,
  proxyConfigDir: runtime,
  proxyCurrentPorts: runtime,
  proxyHttpPorts: runtime,
  proxyHttpsPorts: runtime,
  proxyLastPorts: runtime,
  proxyScanHttp: runtime,
  proxyScanHttps: runtime,
  proxyDomain: runtime,
  proxyIp: runtime,
  dockerBinDir: runtime,
  orchestratorMV: runtime,
  uid: runtime,
  gid: runtime,
  username: runtime,
  caCert: runtime,
  caKey: runtime,
  caDomain: runtime,
  userConfRoot: runtime,
  home: runtime,
  configSources: runtime,
  envPrefix: runtime,
  product: runtime,
  hyperdrive: runtime,
  runtime,
  version: runtime,
  cli: runtime,
  coreBase: runtime,
  srcRoot: runtime,
  fatcore: runtime,
  packaged: runtime,
  leia: runtime,
  os: runtime,
  isArmed: runtime,
  node: runtime,
  process: runtime,
  instance: runtime,
  id: runtime,
  user: runtime,
  env: runtime,
  command: runtime,
  landoFileConfig: runtime,
  hconf: runtime,
};

export const hasTopLevelDisposition = (key: string): boolean => Object.hasOwn(TOP_LEVEL_DISPOSITIONS, key);

export const unknownKeyDiagnostics = (
  unknownKeys: readonly Lando3Path[],
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): readonly ConfigTranslateDiagnostic[] =>
  unknownKeys
    .filter((path) => !(path.length === 1 && typeof path[0] === "string" && hasTopLevelDisposition(path[0])))
    .map((keyPath) => {
      const occurrence = occurrencesAt(merged, keyPath).at(-1);
      return {
        kind: "dropped" as const,
        sourceId: occurrence?.sourceId ?? fallback,
        keyPath: [...keyPath],
        span: spanOf(occurrence),
        message: `${formatPath(keyPath)} is not a Lando 3 key and was ignored by Lando 3 as well.`,
        remediation: `Remove ${formatPath(keyPath)}, or author the Lando 4 value you intended.`,
      };
    });

const configuredBasenames = (value: MergedLegacyValue): readonly string[] => {
  switch (value.kind) {
    case "scalar":
      return typeof value.value === "string" && value.value.length > 0 ? [value.value] : [];
    case "sequence":
      return value.items.flatMap((item) => configuredBasenames(item.value));
    case "tagged":
      return configuredBasenames(value.value);
    case "mapping":
      return [];
    default:
      return value satisfies never;
  }
};

export const topLevelDispositions = (
  merged: MergedLegacyValue | undefined,
  fallback: ConfigTranslateSourceId,
): readonly ConfigTranslateDiagnostic[] => {
  if (merged?.kind !== "mapping") return [];
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const report = makeReport(
    { fallbackSourceId: fallback, occurrenceAt: (path) => occurrencesAt(merged, path).at(-1) },
    diagnostics,
  );
  for (const [key, value] of merged.entries) {
    if (!hasTopLevelDisposition(key)) continue;
    const disposition = TOP_LEVEL_DISPOSITIONS[key];
    if (disposition === undefined) continue;
    const names = disposition.kind === "needs-review" ? configuredBasenames(value) : [];
    const message = names.length > 0 ? `${disposition.message}: ${names.join(", ")}.` : disposition.message;
    report(disposition.kind, [key], message, disposition.remediation);
  }
  return diagnostics;
};
