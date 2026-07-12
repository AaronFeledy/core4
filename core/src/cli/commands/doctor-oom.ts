import type { HostPlatform } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import type { DoctorCheck, DoctorProviderKind, DoctorSolution } from "./doctor.ts";

/**
 * Best-effort correlation of a Podman container died event to the affected
 * app/service. Podman 6 exposes these through the event `Actor.Attributes`
 * (container `name`/`image`, exit code, and Lando/compose labels); everything
 * here is optional because a died-event payload may omit any of it.
 */
export interface DiedEventCorrelation {
  readonly containerName?: string;
  readonly image?: string;
  readonly exitCode?: number;
  readonly app?: string;
  readonly service?: string;
}

/**
 * Structural classification of a Podman container died-event payload.
 *
 * - `oom`       — an owned container died event with the Podman 6 `OOMKilled` attribute set.
 * - `died`      — a container died event without `OOMKilled` set ("if set" semantics).
 * - `unrelated` — a recognizable event that is not a container died event or is an unowned OOM event.
 * - `malformed` — a payload that cannot be recognized as a Podman event at all.
 */
export type DiedEventClassification =
  | { readonly kind: "oom"; readonly correlation: DiedEventCorrelation }
  | { readonly kind: "died"; readonly correlation: DiedEventCorrelation }
  | { readonly kind: "unrelated" }
  | { readonly kind: "malformed" };

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringAttr = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const parseExitCode = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value.trim());
  return undefined;
};

/**
 * Read the Podman 6 `OOMKilled` marker. The release notes describe it as a new
 * attribute that is present "if set", so anything other than an explicit truthy
 * boolean/string is treated as not set.
 */
const readOomKilled = (
  event: Record<string, unknown>,
  attrs: Record<string, unknown> | undefined,
): boolean => {
  const candidates: ReadonlyArray<unknown> = [event.OOMKilled, attrs?.OOMKilled, attrs?.oomKilled];
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") {
      if (candidate) return true;
      continue;
    }
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true" || normalized === "1") return true;
    }
  }
  return false;
};

const eventAction = (event: Record<string, unknown>): string | undefined => {
  const action =
    stringAttr(event.Action) ??
    stringAttr(event.Status) ??
    stringAttr(event.status) ??
    stringAttr(event.podman_event_name);
  return action?.trim().toLowerCase();
};

const isRecognizableEvent = (event: Record<string, unknown>): boolean =>
  eventAction(event) !== undefined || stringAttr(event.Type) !== undefined;

const isContainerDiedEvent = (event: Record<string, unknown>): boolean => {
  const type = stringAttr(event.Type);
  const isContainer = type === undefined || type === "container";
  const action = eventAction(event);
  return isContainer && (action === "died" || action === "die");
};

const buildCorrelation = (event: Record<string, unknown>): DiedEventCorrelation => {
  const actor = asRecord(event.Actor);
  const attrs = asRecord(actor?.Attributes) ?? asRecord(event.Attributes);
  const containerName = stringAttr(attrs?.name) ?? stringAttr(event.Name);
  const image = stringAttr(attrs?.image) ?? stringAttr(event.Image);
  const exitCode = parseExitCode(attrs?.containerExitCode ?? event.ContainerExitCode ?? attrs?.exitCode);
  const app = stringAttr(attrs?.["dev.lando.app"]) ?? stringAttr(attrs?.["com.docker.compose.project"]);
  const service =
    stringAttr(attrs?.["dev.lando.service"]) ?? stringAttr(attrs?.["com.docker.compose.service"]);
  return {
    ...(containerName === undefined ? {} : { containerName }),
    ...(image === undefined ? {} : { image }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(app === undefined ? {} : { app }),
    ...(service === undefined ? {} : { service }),
  };
};

const hasOwnerCorrelation = (correlation: DiedEventCorrelation): boolean =>
  correlation.app !== undefined && correlation.service !== undefined;

/**
 * Classify a raw Podman container died-event payload. Pure and total: never
 * throws; redaction happens in {@link buildOomDoctorCheck} at the doctor-check boundary.
 */
export const classifyDiedEvent = (payload: unknown): DiedEventClassification => {
  const event = asRecord(payload);
  if (event === undefined) return { kind: "malformed" };
  if (!isRecognizableEvent(event)) return { kind: "malformed" };
  if (!isContainerDiedEvent(event)) return { kind: "unrelated" };
  const correlation = buildCorrelation(event);
  if (!readOomKilled(event, asRecord(asRecord(event.Actor)?.Attributes) ?? asRecord(event.Attributes))) {
    return { kind: "died", correlation };
  }
  return hasOwnerCorrelation(correlation) ? { kind: "oom", correlation } : { kind: "unrelated" };
};

export interface OomDoctorContext {
  readonly provider: { readonly id: string; readonly displayName: string; readonly version: string };
  readonly providerKind: DoctorProviderKind;
  readonly platform: HostPlatform;
}

export const OOM_CHECK_NAME = "runtime-oom";

const secretsRedactor = createRedactor("secrets");
const redact = (value: string): string => secretsRedactor.redactString(value);

const baseSolution = (): DoctorSolution => ({
  kind: "manual",
  description:
    "A container was stopped because it ran out of memory (OOMKilled). Increase the Podman machine or runtime memory, reduce the service's memory demand, or inspect the service logs with `lando logs`.",
  command: "lando logs",
});

const podmanDesktopSolution = (): DoctorSolution => ({
  kind: "manual",
  description:
    "On macOS and Windows, raise the Podman machine memory in Podman Desktop's machine resource settings, then restart the machine before retrying.",
});

/**
 * Build a doctor check for an OOM-killed container. Returns `undefined` for any
 * non-OOM classification so callers never surface a false diagnostic. All
 * correlation identifiers are redacted through the shared secrets redactor
 * before they reach the check context, so no raw event payload leaks into
 * doctor text/NDJSON output or transcripts.
 */
export const buildOomDoctorCheck = (
  classification: DiedEventClassification,
  { provider, providerKind, platform }: OomDoctorContext,
): DoctorCheck | undefined => {
  if (classification.kind !== "oom") return undefined;
  const { correlation } = classification;
  const context: Record<string, string> = {};
  if (correlation.containerName !== undefined) context.containerName = redact(correlation.containerName);
  if (correlation.image !== undefined) context.image = redact(correlation.image);
  if (correlation.exitCode !== undefined) context.exitCode = String(correlation.exitCode);
  if (correlation.app !== undefined) context.app = redact(correlation.app);
  if (correlation.service !== undefined) context.service = redact(correlation.service);

  const solutions =
    platform === "darwin" || platform === "win32"
      ? [baseSolution(), podmanDesktopSolution()]
      : [baseSolution()];

  return {
    name: OOM_CHECK_NAME,
    status: "fail",
    severity: "error",
    providerId: provider.id,
    providerName: provider.displayName,
    providerVersion: provider.version,
    providerKind,
    runtimeStatus: "oom-killed",
    runtime: { running: false, message: "oom-killed", oomKilled: true },
    capabilities: {},
    context,
    solutions,
  };
};

/**
 * Classify a batch of died-event payloads and return a doctor check for each
 * OOM-killed container, skipping every non-OOM or malformed payload.
 */
export const collectOomDoctorChecks = (
  payloads: ReadonlyArray<unknown>,
  context: OomDoctorContext,
): ReadonlyArray<DoctorCheck> =>
  payloads.flatMap((payload) => {
    const check = buildOomDoctorCheck(classifyDiedEvent(payload), context);
    return check === undefined ? [] : [check];
  });
