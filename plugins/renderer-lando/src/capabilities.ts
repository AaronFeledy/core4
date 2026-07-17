import {
  RENDERER_CAPABILITIES_NONE,
  RENDERER_CAPABILITIES_TTY_INITIAL,
  type RendererCapabilities,
} from "@lando/sdk/renderer";

export type CapabilityProbeOutcome =
  | { readonly kind: "success"; readonly color: boolean; readonly notifications: boolean }
  | { readonly kind: "timeout" }
  | { readonly kind: "no-response" };

export type CapabilityProbe = {
  readonly run: () => Promise<CapabilityProbeOutcome>;
  readonly timeoutMs: number;
};

export type CapabilitySnapshotHandle = {
  readonly get: () => RendererCapabilities;
  readonly promote: (next: RendererCapabilities) => void;
};

export const createCapabilitySnapshot = (initial: RendererCapabilities): CapabilitySnapshotHandle => {
  let current: RendererCapabilities = initial;
  let promoted = false;
  return {
    get: () => current,
    promote: (next) => {
      if (promoted) return;
      if (current.interactive && !next.interactive) return;
      if (current.animation && !next.animation) return;
      if (current.color && !next.color) return;
      if (current.notifications && !next.notifications) return;
      current = Object.freeze({ ...next });
      promoted = true;
    },
  };
};

export const promoteFromProbe = (handle: CapabilitySnapshotHandle, outcome: CapabilityProbeOutcome): void => {
  if (outcome.kind !== "success") return;
  const base = handle.get();
  handle.promote(
    Object.freeze({
      color: base.color || outcome.color,
      interactive: base.interactive,
      animation: base.animation,
      notifications: base.notifications || outcome.notifications,
    }),
  );
};

export const defaultTtyInitialSnapshot = (): RendererCapabilities => RENDERER_CAPABILITIES_TTY_INITIAL;
export const noneSnapshot = (): RendererCapabilities => RENDERER_CAPABILITIES_NONE;

/**
 * Default substrate probe: no real wall clock in production beyond a short
 * timeout; tests inject a fake probe. Without a live OpenTUI CliRenderer handle
 * at service construction, production starts at the initial snapshot and leaves
 * promotion to an optional injected probe.
 */
export const scheduleCapabilityProbe = (
  handle: CapabilitySnapshotHandle,
  probe: CapabilityProbe | undefined,
  clock: { readonly setTimeout: (fn: () => void, ms: number) => unknown } = globalThis,
): void => {
  if (probe === undefined) return;
  let settled = false;
  const finish = (outcome: CapabilityProbeOutcome) => {
    if (settled) return;
    settled = true;
    promoteFromProbe(handle, outcome);
  };
  clock.setTimeout(() => finish({ kind: "timeout" }), probe.timeoutMs);
  void probe.run().then(
    (outcome) => finish(outcome),
    () => finish({ kind: "no-response" }),
  );
};
