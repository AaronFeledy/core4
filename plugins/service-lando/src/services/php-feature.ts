import {
  ARTIFACT_REFRESH_EXTENSION,
  DEBUGGER_HOST_ALIAS,
  HOST_GATEWAY_TARGET,
  PortablePath,
  STOCK_TAG_REFRESH_AFTER_MS,
  landoCacheStoreName,
} from "@lando/sdk/schema";
import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema, absurd } from "effect";
import { addEnvRecord, serviceFeatureApply, serviceFeatureValidateEffective } from "./_feature-helpers.ts";
import {
  assertListenerConfig,
  imageAuthority,
  launcherAuthority,
  servicePortEndpoints,
} from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";
import {
  DEBIAN_APACHE_PORTS_CONF_PATH,
  apacheDebianSslBuildStep,
  apacheListenBuildStep,
  authoredListenPort,
} from "./apache.ts";
import { generatedHttpsEndpoint, nativeTlsEligible, nativeTlsListener } from "./apache-native-tls.ts";
import { SUPPORTED_PHP_VERSIONS } from "./default-images.ts";
import { landoErrorPagesBuildStep } from "./http-errors.ts";
import { phpBaselineBuildStep } from "./php-baseline.ts";
import { phpComposerPackagesBuildStep, resolvePhpComposerPackages } from "./php-composer-packages.ts";
import { PHP_COMPOSER_STEP_ID, phpPrerequisiteBuildSteps, resolvePhpComposer } from "./php-prerequisites.ts";
import { PhpRuntimePolicy } from "./php-runtime-policy.ts";
import {
  PHP_CLI_KEEP_ALIVE,
  PHP_LISTENERS,
  apacheDefaultSiteRemovalBuildStep,
  apacheStartCommand,
  fpmStartCommand,
  phpServingMode,
} from "./php-via.ts";
import { PHP_WP_CLI_STEP } from "./php-wp-cli.ts";
import { phpXdebugBuildStep, phpXdebugConfigEnv, resolvePhpXdebug } from "./php-xdebug.ts";

export const PHP_FEATURE_ID = "service-lando.php";
export const PHP_FEATURE_PRIORITY = 600;
export const PHP_COMPOSER_CACHE = {
  store: landoCacheStoreName("composer"),
  target: PortablePath.make("/var/lib/lando/composer-cache"),
  readOnly: false,
  kind: "cache",
  key: "composer",
} as const;
const PhpFeatureConfig = Schema.Struct({
  allowOverride: Schema.Boolean,
  version: Schema.Literals(SUPPORTED_PHP_VERSIONS),
  via: Schema.Literals(["apache", "fpm", "cli"]),
  webroot: Schema.String,
  uploadDirs: Schema.optionalKey(Schema.Array(Schema.String)),
  policy: PhpRuntimePolicy,
});

const applyPhpFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { allowOverride, version, via, webroot, policy, uploadDirs } = Schema.decodeUnknownSync(
    PhpFeatureConfig,
  )(ctx.config);
  const mode = phpServingMode(via, authoredListenPort(service.port));
  if (mode.listener !== undefined) {
    assertListenerConfig(service, mode.via === "fpm" ? PHP_LISTENERS.fpm : PHP_LISTENERS.apache);
  }
  if (policy.reference !== undefined) ctx.setArtifact({ kind: "ref", ref: policy.reference });
  const stock = policy.artifactSource === "stock";
  if (stock) ctx.addExtension(ARTIFACT_REFRESH_EXTENSION, { afterMs: STOCK_TAG_REFRESH_AFTER_MS });
  const xdebug = resolvePhpXdebug(service.xdebug);
  const composerRelease = resolvePhpComposer(service.composer);
  if (stock && composerRelease !== false) {
    const { store, target, readOnly } = PHP_COMPOSER_CACHE;
    ctx.addStorage({ store, target, readOnly });
    if (service.environment?.COMPOSER_CACHE_DIR === undefined) ctx.addEnv("COMPOSER_CACHE_DIR", target);
  }
  if (stock) {
    const baseline = phpBaselineBuildStep();
    if (baseline !== undefined) ctx.addBuildStep(baseline);
    for (const step of phpPrerequisiteBuildSteps(service.composer)) ctx.addBuildStep(step);
    if (service.framework === "wordpress") {
      ctx.addBuildStep(PHP_WP_CLI_STEP);
      addEnvRecord(ctx, { WP_CLI_ALLOW_ROOT: "1" });
    }
    if (xdebug !== false) ctx.addBuildStep(phpXdebugBuildStep(version, xdebug));
  }
  const packages = phpComposerPackagesBuildStep(resolvePhpComposerPackages(service.composer), {
    dependsOnComposerStep: stock && composerRelease !== false,
    composerStepId: PHP_COMPOSER_STEP_ID,
  });
  if (packages !== undefined) ctx.addBuildStep(packages);
  if (xdebug !== false) {
    addEnvRecord(ctx, phpXdebugConfigEnv());
    ctx.addHostAlias({ hostname: DEBUGGER_HOST_ALIAS, ip: HOST_GATEWAY_TARGET });
  }
  switch (mode.via) {
    case "apache":
      ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
      if (policy.processAuthority === "lando") {
        const nativeTls = nativeTlsEligible({ owned: true, config: service });
        ctx.addBuildStep(apacheDefaultSiteRemovalBuildStep());
        ctx.addBuildStep(landoErrorPagesBuildStep());
        if (mode.authoredApachePort !== undefined)
          ctx.addBuildStep(apacheListenBuildStep(DEBIAN_APACHE_PORTS_CONF_PATH));
        if (nativeTls) ctx.addBuildStep(apacheDebianSslBuildStep());
        ctx.setCommand([
          ...apacheStartCommand(
            webroot,
            allowOverride,
            mode.authoredApachePort,
            service.user === undefined,
            uploadDirs,
            nativeTls
              ? nativeTlsListener({
                  plainPort: mode.listener.port,
                  serviceName: ctx.serviceName,
                  appName: ctx.appName ?? "app",
                  appRoot: ctx.appRoot,
                })
              : undefined,
          ),
          ...(service.environment?.BACKDROP_SETTINGS === undefined
            ? []
            : ["-c", "PassEnv BACKDROP_SETTINGS"]),
        ]);
      }
      break;
    case "fpm":
      if (policy.processAuthority === "lando")
        ctx.setCommand(fpmStartCommand(mode.listener.port, service.user === undefined));
      break;
    case "cli":
      if (policy.processAuthority === "lando") ctx.setCommand([...PHP_CLI_KEEP_ALIVE]);
      break;
    default:
      absurd(mode);
  }
  if (mode.listener !== undefined) {
    ctx.setHealthcheck(tcpProbe(mode.listener.port, 10));
    const contract = mode.via === "fpm" ? PHP_LISTENERS.fpm : PHP_LISTENERS.apache;
    switch (policy.processAuthority) {
      case "authored":
        ctx.setListenerAuthority(launcherAuthority(contract, mode.listener.port));
        break;
      case "image-default":
        ctx.setListenerAuthority(imageAuthority(contract, mode.listener.port));
        break;
      case "lando":
        break;
      default:
        absurd(policy.processAuthority);
    }
  }
  applyAuthoredProcessFields(ctx, ["user", "command", "entrypoint"]);
  ctx.addExtension("lando-service-php", { allowOverride, webroot, version, via });
};

export const phpServiceFeature: ServiceFeatureDefinition = {
  id: PHP_FEATURE_ID,
  schema: PhpFeatureConfig,
  priority: PHP_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(PHP_FEATURE_ID, (ctx) => {
    const { webroot, via, policy } = Schema.decodeUnknownSync(PhpFeatureConfig)(ctx.config);
    return {
      handledServiceFields: [
        ...(webroot.length > 0 ? ["webroot" as const] : []),
        ...(via === "apache" && policy.processAuthority === "lando" ? ["uploadDirs" as const] : []),
      ],
    };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const { via, policy } = Schema.decodeUnknownSync(PhpFeatureConfig)(ctx.config);
      const { listener } = phpServingMode(via, authoredListenPort(ctx.normalizedConfig.port));
      if (listener === undefined) return [];
      const endpoints = servicePortEndpoints(ctx, listener);
      const owned = via === "apache" && policy.processAuthority === "lando";
      return nativeTlsEligible({ owned, config: ctx.normalizedConfig })
        ? [...endpoints, generatedHttpsEndpoint({ serviceName: ctx.serviceName, plainPort: listener.port })]
        : endpoints;
    }),
  apply: serviceFeatureApply(PHP_FEATURE_ID, "service-lando.php failed to apply", applyPhpFeature),
};
