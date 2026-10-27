/**
 * Scanner, home, and host-reachability intent for converted services.
 *
 * Lando 3 persisted every Lando service's home, probed published URLs after
 * start, and let authors wire `host.lando.internal` by hand. Lando 4 does all
 * three from typed settings and provider capability, so these helpers emit the
 * typed settings and remove the hand wiring instead of copying it.
 */
import { isLegacyTagged } from "@lando/sdk/landofile";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId, ServiceName } from "@lando/sdk/schema";
import type { Lando3Path } from "./contract.ts";
import {
  type LoweringPatch,
  type ServiceLoweringContext,
  hasPlainObjectPrototype,
} from "./lowering-contract.ts";
import { type Report, lowerText } from "./lowering-report.ts";
import { droppedServiceKey, rewrittenServiceKey, unsupportedServiceKey } from "./service-diagnostics.ts";

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
  const report: Report = (kind, relative, message, remediation) => {
    const input = { ctx, relative, message, remediation };
    diagnostics.push(
      kind === "rewritten"
        ? rewrittenServiceKey(input)
        : kind === "unsupported"
          ? unsupportedServiceKey(input)
          : droppedServiceKey(input),
    );
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
  if (!hasPlainObjectPrototype(value) || isLegacyTagged(value)) {
    drop(
      [],
      "Scanner must be false or a settings mapping.",
      "Set scanner: false or scanner settings by hand.",
    );
    return undefined;
  }
  const scanner: Record<string, unknown> = {};
  if (typeof value.path === "string") {
    const text = lowerText(value.path, ["scanner", "path"], report);
    if (typeof text === "string") scanner.path = text.startsWith("/") ? text : `/${text}`;
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
  } else if (value.okCodes !== undefined) {
    drop(["okCodes"], "Scanner okCodes must be a list of HTTP status codes.", "Use codes from 100 to 599.");
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
  if (retries !== undefined || typeof scanner.timeout === "number") {
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
  if (value === true) {
    diagnostics.push(
      droppedServiceKey({
        ctx,
        relative: ["home"],
        message: "home: true is the Lando 4 default.",
        remediation:
          "Nothing to set: Lando 4 keeps the service user's home when it knows where that home is.",
      }),
    );
    return undefined;
  }
  const rawPath = hasPlainObjectPrototype(value) && !isLegacyTagged(value) ? value.path : value;
  const report: Report = (kind, relative, message, remediation) => {
    const input = { ctx, relative, message, remediation };
    diagnostics.push(
      kind === "rewritten"
        ? rewrittenServiceKey(input)
        : kind === "unsupported"
          ? unsupportedServiceKey(input)
          : droppedServiceKey(input),
    );
  };
  const path = typeof rawPath === "string" ? lowerText(rawPath, ["home"], report) : rawPath;
  if (path === null) return undefined;
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
      message: "Home must be false or an absolute container path.",
      remediation: "Set home: false or home.path to an absolute container path by hand.",
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

/**
 * Record source intent only. The host assesses the real catalog after merging
 * conversion outputs. Raw Lando 3 Compose services had no implicit home.
 */
export const withHomeIntent = (
  lowered: LoweringPatch,
  service: Readonly<Record<string, unknown>>,
  ctx: ServiceLoweringContext,
): LoweringPatch => {
  const patch = lowered.patch;
  if (lowered.blocked === true || Object.hasOwn(patch, "home")) return lowered;
  if (service.home !== undefined && service.home !== true) return lowered;
  if (service.api !== 4 && service.type === "compose") return lowered;
  const occurrence = ctx.occurrenceAt([]);
  return {
    ...lowered,
    expectations: [
      {
        _tag: "PersistedHome",
        sourceId: occurrence?.sourceId ?? ConfigTranslateSourceId.make(ctx.fallbackSourceId),
        keyPath: ctx.keyPath,
        service: ServiceName.make(ctx.serviceName),
      },
    ],
  };
};
