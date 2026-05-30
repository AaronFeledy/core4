export type DoctorNdjsonStatus = "pass" | "warn" | "fail";

export interface DoctorNdjsonCheck {
  readonly status: DoctorNdjsonStatus;
}

export interface DoctorNdjsonRenderOptions<Check extends DoctorNdjsonCheck> {
  readonly checks: ReadonlyArray<Check>;
  readonly now?: Date | undefined;
  readonly checkEventPayload: (check: Check) => Record<string, unknown>;
}

export const orderKnownKeys = <Value>(
  values: Readonly<Record<string, Value>>,
  knownOrder: ReadonlyArray<string>,
): Record<string, Value> => {
  const ordered: Record<string, Value> = {};
  for (const key of knownOrder) {
    if (Object.hasOwn(values, key)) ordered[key] = values[key] as Value;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = value as Value;
  }
  return ordered;
};

export const renderDoctorChecksAsNdjson = <Check extends DoctorNdjsonCheck>({
  checks,
  now,
  checkEventPayload,
}: DoctorNdjsonRenderOptions<Check>): string => {
  const timestamp = (now ?? new Date()).toISOString();
  const lines: string[] = [];
  lines.push(JSON.stringify({ _tag: "doctor.start", timestamp }));
  for (const check of checks) {
    lines.push(JSON.stringify(checkEventPayload(check)));
  }
  let failed = 0;
  let warned = 0;
  for (const check of checks) {
    if (check.status === "fail") failed += 1;
    else if (check.status === "warn") warned += 1;
  }
  lines.push(
    JSON.stringify({
      _tag: "doctor.complete",
      timestamp,
      checks: checks.length,
      failed,
      warned,
    }),
  );
  return `${lines.join("\n")}\n`;
};
