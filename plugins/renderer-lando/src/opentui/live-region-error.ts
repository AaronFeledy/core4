export type OpenTuiLiveRegionFailureStage = "load" | "initialize";

export class OpenTuiLiveRegionUnavailableError extends Error {
  override readonly name = "OpenTuiLiveRegionUnavailableError";

  constructor(
    readonly stage: OpenTuiLiveRegionFailureStage,
    cause: unknown,
  ) {
    super(`OpenTUI live region failed to ${stage === "load" ? "load" : "initialize"}.`, { cause });
  }
}
