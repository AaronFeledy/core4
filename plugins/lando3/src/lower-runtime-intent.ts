/**
 * Scanner, home, and host-reachability intent for converted services.
 *
 * Lando 3 persisted every Lando service's home, probed published URLs after
 * start, and let authors wire `host.lando.internal` by hand. Lando 4 does all
 * three from typed settings and provider capability, so these helpers emit the
 * typed settings and remove the hand wiring instead of copying it.
 */
import { isLegacyTagged } from "@lando/sdk/landofile";
import type { ConfigTranslateDiagnostic } from "@lando/sdk/schema";
import { SERVICE_HOMES } from "./catalog.ts";
import type { Lando3Path } from "./contract.ts";
import { type LoweringPatch, type ServiceLoweringContext, isPlainObject } from "./lowering-contract.ts";
import {
  droppedServiceKey,
  generatedService,
  needsReviewServiceKey,
  rewrittenServiceKey,
} from "./service-diagnostics.ts";

/** Lando 4 bounds for the post-start probe. */
const MAX_RETRIES = 20;
const DEFAULT_RETRIES = 2;
const MAX_TIMEOUT_MS = 600_000;

const nonNegativeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

const lowerScanner = (
  value: unknown,
  ctx: ServiceLoweringContext,
  diagnostics: ConfigTranslateDiagnostic[],
): unknown => {
  const drop = (relative: Lando3Path, message: string, remediation: string): void => {
    diagnostics.push(droppedServiceKey({ ctx, relative: ["scanner", ...relative], message, remediation }));
  };
  if (value === false) return false;
  if (value === true) {
    drop(
      [],
      "scanner: true is the Lando 4 default.",
      "Nothing to set: Lando 4 scans published URLs after start.",
    );
    return undefined;
  }
  if (!isPlainObject(value) || isLegacyTagged(value)) {
    drop(
      [],
      "Scanner must be false or a settings mapping.",
      "Set scanner: false or scanner settings by hand.",
    );
    return undefined;
  }
  const scanner: Record<string, unknown> = {};
  if (typeof value.path === "string") {
    scanner.path = value.path.startsWith("/") ? value.path : `/${value.path}`;
  } else if (value.path !== undefined) {
    drop(["path"], "Scanner path must be a plain string.", "Set scanner.path to a path such as /health.");
  }
  if (Array.isArray(value.okCodes)) {
    const codes: number[] = [];
    value.okCodes.forEach((code: unknown, index) => {
      if (typeof code === "number" && Number.isInteger(code) && code >= 100 && code <= 599) codes.push(code);
      else
        drop(["okCodes", index], "Scanner okCodes must be HTTP status codes.", "Use codes from 100 to 599.");
    });
    scanner.okCodes = codes;
  }
  const retry = nonNegativeInt(value.retry);
  const retries = retry === undefined ? undefined : Math.min(retry, MAX_RETRIES);
  if (retries !== undefined) scanner.retries = retries;
  else if (value.retry !== undefined) {
    drop(["retry"], "Scanner retry must be a non-negative integer.", "Set scanner.retries by hand.");
  }
  const timeout = nonNegativeInt(value.timeout);
  if (timeout !== undefined && timeout > 0) {
    // Lando 3 bounded each attempt; Lando 4 bounds the whole probe, retries included.
    const attempts = (retries ?? DEFAULT_RETRIES) + 1;
    scanner.timeout = Math.min(timeout * attempts, MAX_TIMEOUT_MS);
  } else if (value.timeout !== undefined) {
    drop(["timeout"], "Scanner timeout must be a positive integer.", "Set scanner.timeout by hand.");
  }
  if (value.maxRedirects !== undefined) {
    drop(
      ["maxRedirects"],
      "Lando 4 has no scanner redirect limit.",
      "Add the redirect status codes the service returns to scanner.okCodes instead.",
    );
  }
  if (value.retry !== undefined || value.timeout !== undefined) {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative: ["scanner"],
        message: `Rewrote scanner retry as retries${retry !== undefined && retry > MAX_RETRIES ? ` capped at ${MAX_RETRIES}` : ""} and the per-attempt timeout as one deadline covering every attempt.`,
        remediation: "Review scanner.retries and scanner.timeout in the generated service.",
      }),
    );
  }
  return scanner;
};

const lowerAuthoredHome = (
  value: unknown,
  ctx: ServiceLoweringContext,
  diagnostics: ConfigTranslateDiagnostic[],
): unknown => {
  const path = isPlainObject(value) && !isLegacyTagged(value) ? value.path : value;
  if (value === false || (typeof path === "string" && path.startsWith("/"))) {
    diagnostics.push(
      rewrittenServiceKey({
        ctx,
        relative: ["home"],
        message: value === false ? "Kept home persistence disabled." : `Rewrote home as home.path ${path}.`,
        remediation: "Review home in the generated service.",
      }),
    );
    return value === false ? false : { path };
  }
  diagnostics.push(
    droppedServiceKey({
      ctx,
      relative: ["home"],
      message:
        value === true
          ? "home: true is the Lando 4 default."
          : "Home must be false or an absolute container path.",
      remediation:
        value === true
          ? "Nothing to set: Lando 4 persists the service user's home when it knows where home is."
          : "Set home: false or home.path to an absolute container path by hand.",
    }),
  );
  return undefined;
};

/** Service-level `scanner` and `home` settings shared by every service family. */
export const lowerScannerAndHome = (
  service: Readonly<Record<string, unknown>>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const diagnostics: ConfigTranslateDiagnostic[] = [];
  const patch: Record<string, unknown> = {};
  if (Object.hasOwn(service, "scanner")) {
    const scanner = lowerScanner(service.scanner, ctx, diagnostics);
    if (scanner !== undefined) patch.scanner = scanner;
  }
  if (Object.hasOwn(service, "home")) {
    const home = lowerAuthoredHome(service.home, ctx, diagnostics);
    if (home !== undefined) patch.home = home;
  }
  return { patch, diagnostics };
};

const suppliedImage = (patch: Readonly<Record<string, unknown>>): boolean =>
  typeof patch.image === "string" || (isPlainObject(patch.build) && Object.hasOwn(patch.build, "context"));

const principal = (user: unknown): string | undefined =>
  typeof user === "string" && user.length > 0 ? (user.split(":")[0] ?? user) : undefined;

/**
 * Lando 3 persisted a home for every Lando service. Lando 4 does the same by
 * default, but only where it knows the planned user's home; anywhere else it
 * refuses to start. Such services get `home: false` plus the explicit path
 * remediation, so the converted app starts and the author decides.
 */
export const withHomeIntent = (
  lowered: LoweringPatch,
  service: Readonly<Record<string, unknown>>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const patch = lowered.patch;
  if (lowered.blocked === true || Object.hasOwn(patch, "home")) return lowered;
  const typeId = typeof patch.type === "string" ? patch.type.split(":")[0] : undefined;
  const known =
    typeId === undefined || !Object.hasOwn(SERVICE_HOMES, typeId) ? undefined : SERVICE_HOMES[typeId];
  let reason: string | undefined;
  if (suppliedImage(patch) || known === undefined) {
    if (service.api !== 4 && service.type === "compose") {
      return {
        ...lowered,
        patch: { ...patch, home: false },
        diagnostics: [
          ...lowered.diagnostics,
          generatedService({
            ctx,
            relative: [],
            message: "Set home: false because Lando 3 never persisted a home for a Compose service.",
            remediation: `Set services.${ctx.serviceName}.home.path if this service should keep its home.`,
          }),
        ],
      };
    }
    reason = "its image comes from the Landofile, so Lando 4 cannot tell where the user's home is";
  } else {
    const user = principal(patch.user) ?? known.defaultUser;
    if (!known.users.includes(user)) {
      reason = `the ${typeId} service type does not declare a home for user ${user}`;
    }
  }
  if (reason === undefined) return lowered;
  return {
    ...lowered,
    patch: { ...patch, home: false },
    diagnostics: [
      ...lowered.diagnostics,
      needsReviewServiceKey({
        ctx,
        relative: [],
        message: `Lando 3 persisted this service's home, but ${reason}; the converted service sets home: false.`,
        remediation: `Set services.${ctx.serviceName}.home.path to that user's home directory (Lando 3 used /var/www) to keep persisting it, or keep home: false.`,
      }),
    ],
  };
};
