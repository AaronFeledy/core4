import type { ServiceFeatureContext, ServiceFeatureDefinition } from "@lando/sdk/services";
import { Effect, Schema, absurd } from "effect";
import { addEnvRecord, serviceFeatureApply, serviceFeatureValidateEffective } from "./_feature-helpers.ts";
import { servicePortEndpoints } from "./_port-helpers.ts";
import { applyAuthoredProcessFields } from "./_process-helpers.ts";
import { tcpProbe } from "./_tcp-probe.ts";
import { DEBIAN_APACHE_PORTS_CONF_PATH, apacheListenBuildStep, authoredListenPort } from "./apache.ts";
import { landoErrorPagesBuildStep } from "./http-errors.ts";
import { phpBaselineBuildStep } from "./php-baseline.ts";
import { phpComposerPackagesBuildStep, resolvePhpComposerPackages } from "./php-composer-packages.ts";
import { PHP_COMPOSER_STEP_ID, phpPrerequisiteBuildSteps, resolvePhpComposer } from "./php-prerequisites.ts";
import { PhpRuntimePolicy } from "./php-runtime-policy.ts";
import {
  PHP_CLI_KEEP_ALIVE,
  SUPPORTED_PHP_VERSIONS,
  apacheDefaultSiteRemovalBuildStep,
  apacheStartCommand,
  fpmStartCommand,
  phpServingMode,
} from "./php-via.ts";
import { PHP_WP_CLI_STEP } from "./php-wp-cli.ts";
import { phpXdebugBuildStep, phpXdebugConfigEnv, resolvePhpXdebug } from "./php-xdebug.ts";

export const PHP_FEATURE_ID = "service-lando.php";
export const PHP_FEATURE_PRIORITY = 600;
const PhpFeatureConfig = Schema.Struct({
  allowOverride: Schema.Boolean,
  version: Schema.Literals(SUPPORTED_PHP_VERSIONS),
  via: Schema.Literals(["apache", "fpm", "cli"]),
  webroot: Schema.String,
  policy: PhpRuntimePolicy,
});

const applyPhpFeature = (ctx: ServiceFeatureContext): void => {
  const service = ctx.normalizedConfig;
  const { allowOverride, version, via, webroot, policy } = Schema.decodeUnknownSync(PhpFeatureConfig)(
    ctx.config,
  );
  const mode = phpServingMode(via, authoredListenPort(service.port));
  if (policy.reference !== undefined) ctx.setArtifact({ kind: "ref", ref: policy.reference });
  const stock = policy.artifactSource === "stock";
  const xdebug = resolvePhpXdebug(service.xdebug);
  const composerRelease = resolvePhpComposer(service.composer);
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
  if (xdebug !== false) addEnvRecord(ctx, phpXdebugConfigEnv());
  switch (mode.via) {
    case "apache":
      ctx.addEnv("APACHE_DOCUMENT_ROOT", webroot);
      if (policy.processAuthority === "lando") {
        ctx.addBuildStep(apacheDefaultSiteRemovalBuildStep());
        ctx.addBuildStep(landoErrorPagesBuildStep());
        if (mode.authoredApachePort !== undefined)
          ctx.addBuildStep(apacheListenBuildStep(DEBIAN_APACHE_PORTS_CONF_PATH));
        ctx.setCommand([
          ...apacheStartCommand(webroot, allowOverride, mode.authoredApachePort, service.user === undefined),
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
  if (mode.listener !== undefined) ctx.setHealthcheck(tcpProbe(mode.listener.port, 10));
  applyAuthoredProcessFields(ctx, ["user", "command", "entrypoint"]);
  ctx.addExtension("lando-service-php", { allowOverride, webroot, version, via });
};

export const phpServiceFeature: ServiceFeatureDefinition = {
  id: PHP_FEATURE_ID,
  schema: PhpFeatureConfig,
  priority: PHP_FEATURE_PRIORITY,
  validateEffective: serviceFeatureValidateEffective(PHP_FEATURE_ID, (ctx) => {
    const { webroot } = Schema.decodeUnknownSync(PhpFeatureConfig)(ctx.config);
    return { handledServiceFields: webroot.length > 0 ? ["webroot"] : [] };
  }),
  declareEndpoints: (ctx) =>
    Effect.sync(() => {
      const { via } = Schema.decodeUnknownSync(PhpFeatureConfig)(ctx.config);
      const { listener } = phpServingMode(via, authoredListenPort(ctx.normalizedConfig.port));
      return listener === undefined ? [] : servicePortEndpoints(ctx, listener);
    }),
  apply: serviceFeatureApply(PHP_FEATURE_ID, "service-lando.php failed to apply", applyPhpFeature),
};
