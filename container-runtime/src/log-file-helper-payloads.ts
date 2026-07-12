export type LogFileHelperPayloadKey = "linux-x64" | "linux-arm64";

export type LogFileHelperPayloads = Partial<Record<LogFileHelperPayloadKey, Uint8Array>>;

export interface LogFileHelperTarget {
  readonly os: "linux";
  readonly arch: "x64" | "arm64";
}

export const logFileHelperPayloadForTarget = (
  payloads: LogFileHelperPayloads | undefined,
  target: LogFileHelperTarget | undefined,
): Uint8Array | undefined => {
  if (payloads === undefined || target === undefined) return undefined;
  return payloads[`linux-${target.arch}`];
};

export const logFileHelperPayloadForTargets = (
  payloads: LogFileHelperPayloads | undefined,
  targets: ReadonlyArray<LogFileHelperTarget> | undefined,
): Uint8Array | undefined => {
  for (const target of targets ?? []) {
    const payload = logFileHelperPayloadForTarget(payloads, target);
    if (payload !== undefined) return payload;
  }
  return undefined;
};
