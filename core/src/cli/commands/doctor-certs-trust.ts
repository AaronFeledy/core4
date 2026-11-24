/** `lando doctor` certs findings for the per-store trust inventory of a trusted local CA root. */
import type { TrustStoreStatus } from "@lando/sdk/schema";

import { passCheckNamed, warnCheck } from "./doctor-check-builders";
import type { DoctorFinding, DoctorSolution } from "./doctor-contract";

/** One manual fix for a store that does not trust the root; only a plain rerun of setup is a command. */
export const storeSolution = (store: TrustStoreStatus): DoctorSolution => {
  const where = store.location === undefined ? "" : ` at ${store.location}`;
  const why = store.detail === undefined ? "" : `: ${store.detail}`;
  const sentence = `${store.name}${where} does not trust the local CA${why}`;
  const description = [/[.!?]$/u.test(sentence) ? sentence : `${sentence}.`, store.remediation]
    .filter((part) => part !== undefined)
    .join(" ");
  return {
    kind: "manual",
    description,
    ...(store.remediation?.startsWith("Run `lando setup`") === true ? { command: "lando setup" } : {}),
  };
};

/** A selected authority whose root the system store trusts. */
export interface TrustedRootStatus {
  readonly id: string;
  readonly trustStores: ReadonlyArray<TrustStoreStatus>;
  readonly trustStoresDetail?: string;
}

/**
 * The certs finding once the system store trusts the root: pass when every managed store trusts it
 * too, otherwise warn with one manual solution per store. Never installs trust, even under `--fix`.
 */
export const trustedRootCheck = (status: TrustedRootStatus, fix: boolean): DoctorFinding => {
  const context = {
    subsystem: "certs",
    subsystemId: status.id,
    ready: "true",
    certsTrusted: "true",
    ...(status.trustStoresDetail === undefined ? {} : { certsDetail: status.trustStoresDetail }),
  };
  const details = status.trustStores.length === 0 ? {} : { details: { trustStores: status.trustStores } };
  const degraded = status.trustStores.filter(({ state }) => state !== "trusted");
  if (degraded.length === 0)
    return { ...passCheckNamed({ name: "certs", recovery: "manual", context }), ...details };
  const certsReason = degraded.some(({ state }) => state === "untrusted")
    ? "store-untrusted"
    : "store-unknown";
  return {
    ...warnCheck({
      name: "certs",
      recovery: "manual",
      context: { ...context, certsReason, ...(fix ? { fixOutcome: "skipped-manual" } : {}) },
      solutions: degraded.map(storeSolution),
    }),
    ...details,
  };
};
