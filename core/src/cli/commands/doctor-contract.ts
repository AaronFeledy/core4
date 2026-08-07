/**
 * Shared `lando doctor` result contract.
 *
 * Extracted so the plugin-check runner and the provider diagnostics can both
 * depend on these shapes without an import cycle.
 */
import type { ProviderSelectionSource } from "@lando/engine/providers/precedence";
import type { DoctorSelfCheck } from "./doctor-self";

export type DoctorStatus = "pass" | "warn" | "fail";
export type DoctorSeverity = "info" | "warn" | "error";
export type DoctorSolutionKind = "automatic" | "manual";
export type DoctorProviderKind = "managed" | "user-installed";

const MANAGED_PROVIDER_IDS: ReadonlySet<string> = new Set(["lando"]);

export const providerKindFor = (providerId: string): DoctorProviderKind =>
  MANAGED_PROVIDER_IDS.has(providerId) ? "managed" : "user-installed";

export interface DoctorSolution {
  readonly kind: DoctorSolutionKind;
  readonly description: string;
  readonly command?: string;
}

export interface DoctorRuntime {
  readonly running: boolean;
  readonly message?: string;
  readonly version?: string;
  // Present only when a container died event reported the OOMKilled attribute.
  readonly oomKilled?: boolean;
}

export interface DoctorSelectionRecord {
  readonly providerId: string;
  readonly source: ProviderSelectionSource;
  readonly inputs: {
    readonly flag?: string;
    readonly landofile?: string;
    readonly env?: string;
    readonly config?: string;
    readonly capabilityDefault: string;
  };
}

export interface DoctorCheck {
  readonly name: string;
  readonly status: DoctorStatus;
  readonly severity: DoctorSeverity;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerVersion: string;
  readonly providerKind: DoctorProviderKind;
  readonly runtimeStatus: string;
  readonly runtime: DoctorRuntime;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly context: Readonly<Record<string, string>>;
  readonly solutions: ReadonlyArray<DoctorSolution>;
  readonly selection?: DoctorSelectionRecord;
}

export interface DoctorResult {
  readonly checks: ReadonlyArray<DoctorCheck>;
  /**
   * Failures of doctor's own machinery while producing the provider section.
   * Lifted into the report-level `self` section by `doctorReport`.
   */
  readonly selfChecks?: ReadonlyArray<DoctorSelfCheck>;
}
