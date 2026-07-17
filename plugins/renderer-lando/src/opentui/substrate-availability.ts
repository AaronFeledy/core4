export type OpenTuiSubstrateAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly cause: Error };

let availability: OpenTuiSubstrateAvailability = { available: true };
let degradationNoticeAvailable = true;

export const getOpenTuiSubstrateAvailability = (): OpenTuiSubstrateAvailability => availability;

export const recordOpenTuiSubstrateFailure = (cause: unknown): Error => {
  if (!availability.available) return availability.cause;
  const error =
    cause instanceof Error ? cause : new Error("OpenTUI substrate failed with a non-Error cause.", { cause });
  availability = { available: false, cause: error };
  return error;
};

export const claimOpenTuiDegradationNotice = (): Error | undefined => {
  if (availability.available || !degradationNoticeAvailable) return undefined;
  degradationNoticeAvailable = false;
  return availability.cause;
};

export const resetOpenTuiSubstrateAvailabilityForTests = (): void => {
  availability = { available: true };
  degradationNoticeAvailable = true;
};
