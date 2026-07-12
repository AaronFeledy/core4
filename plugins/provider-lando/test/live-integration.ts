export interface LiveIntegrationSkip {
  readonly kind: "environment";
  readonly reason: string;
}

export type LiveIntegrationEligibility =
  | { readonly available: true }
  | { readonly available: false; readonly skip: LiveIntegrationSkip };

export const liveIntegrationEligibility = (
  prerequisites: ReadonlyArray<{ readonly available: boolean; readonly reason: string }>,
): LiveIntegrationEligibility => {
  const missing = prerequisites.find((prerequisite) => !prerequisite.available);
  return missing === undefined
    ? { available: true }
    : { available: false, skip: { kind: "environment", reason: missing.reason } };
};

export const liveIntegrationTestName = (name: string, eligibility: LiveIntegrationEligibility): string =>
  eligibility.available ? name : `${name} [skip:${eligibility.skip.kind}:${eligibility.skip.reason}]`;
