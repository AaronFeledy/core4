import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  type V4Wire,
  containerWebroot,
  isPlainObject,
} from "./lowering-contract.ts";
import {
  deferredServiceKey,
  droppedServiceKey,
  generatedService,
  rewrittenServiceKey,
} from "./service-diagnostics.ts";

export const lowerPhpOptions = (
  service: Record<string, unknown>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const patch: Record<string, unknown> = {};
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  let companions: Readonly<Record<string, V4Wire>> | undefined;
  const via = service.via;
  const webrootPath = containerWebroot(service.webroot);

  if (Object.hasOwn(service, "via")) {
    if (via === "apache" || (typeof via === "string" && via.startsWith("apache:"))) {
      patch.via = "apache";
      if (via !== "apache") {
        diagnostics.push(
          rewrittenServiceKey({
            ctx,
            relative: ["via"],
            message: "The Apache version suffix was removed from the PHP serving mode.",
            remediation:
              "Review the Apache version supplied by the selected PHP image; via now selects only apache mode.",
          }),
        );
      }
    } else if (via === "cli" || via === "fpm") {
      patch.via = via;
    } else if (via === "nginx" || (typeof via === "string" && via.startsWith("nginx:"))) {
      const companionName = `${ctx.serviceName}-nginx`;
      patch.via = "fpm";
      companions = {
        [companionName]: {
          type: "nginx",
          backend: ctx.serviceName,
          ...(Object.hasOwn(service, "webroot") ? { webroot: webrootPath ?? service.webroot } : {}),
        },
      };
      diagnostics.push(
        generatedService({
          ctx,
          relative: ["via"],
          message: `Generated nginx service ${companionName} with backend ${ctx.serviceName}.`,
          remediation: `Review ${companionName} as the HTTP frontend for ${ctx.serviceName}.`,
        }),
        rewrittenServiceKey({
          ctx,
          relative: ["via"],
          message:
            "Nginx-fronted PHP was split into PHP-FPM and a separate nginx service with a backend reference.",
          remediation:
            via === "nginx"
              ? `Review routes to use ${companionName} as the frontend.`
              : `The nginx version suffix was discarded; select the desired version on ${companionName} and review routes to use it as the frontend.`,
        }),
      );
    } else {
      diagnostics.push(
        droppedServiceKey({
          ctx,
          relative: ["via"],
          message: "The PHP serving mode cannot be converted to Lando 4.",
          remediation:
            "Choose apache, fpm, or cli, or configure a separate nginx service with a backend reference.",
        }),
      );
    }
  }

  if (Object.hasOwn(service, "webroot")) patch.webroot = webrootPath ?? service.webroot;

  if (service.composer_version === false) {
    patch.composer = false;
  } else {
    const version = typeof service.composer_version === "string" ? service.composer_version : undefined;
    const packages = isPlainObject(service.composer)
      ? Object.fromEntries(
          Object.entries(service.composer).map(([name, constraint]) => [name, String(constraint)]),
        )
      : undefined;
    if (version !== undefined || packages !== undefined) {
      patch.composer = {
        ...(version === undefined ? {} : { version }),
        ...(packages === undefined ? {} : { packages }),
      };
    }
    if (version !== undefined) {
      diagnostics.push(
        rewrittenServiceKey({
          ctx,
          relative: ["composer_version"],
          message: "composer_version was renamed to composer.version.",
          remediation: "Manage the Composer version under composer.version in the generated service.",
        }),
      );
    }
  }

  const xdebug = service.xdebug;
  if (typeof xdebug === "boolean" || typeof xdebug === "string") {
    patch.xdebug = xdebug;
  } else if (isPlainObject(xdebug)) {
    patch.xdebug = typeof xdebug.mode === "string" && xdebug.mode.length > 0 ? xdebug.mode : true;
    for (const key of Object.keys(xdebug)) {
      if (key !== "mode")
        diagnostics.push(deferredServiceKey({ ctx, relative: ["xdebug", key], key: "xdebug" }));
    }
  }

  if (Object.hasOwn(service, "db_client")) patch.db_client = service.db_client;
  return { patch, ...(companions === undefined ? {} : { companions }), diagnostics };
};
