export type Baseline = {
  readonly description: string;
  readonly platform: "linux-x64";
  readonly command: ReadonlyArray<string>;
  readonly runs: number;
  readonly startupBudgetMs: number;
  readonly firstOutputBudgetMs: number;
};

export class BaselineError extends Error {
  override readonly name = "BaselineError";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const readBaselineRecord = async (path: string, key: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = await Bun.file(path).json();
  if (!isRecord(parsed) || !(key in parsed)) {
    throw new BaselineError(`Baseline JSON must contain ${key}`);
  }
  const record = parsed[key];
  if (!isRecord(record)) throw new BaselineError(`${key} baseline must be an object`);
  return record;
};

const stringField = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new BaselineError(`Baseline field ${key} must be a non-empty string`);
  }
  return value;
};

export const numberField = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new BaselineError(`Baseline field ${key} must be a positive number`);
  }
  return value;
};

const isNonEmptyStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry: unknown): entry is string => typeof entry === "string");

export const readBaseline = async (path: string): Promise<Baseline> => {
  const record = await readBaselineRecord(path, "openTuiStartup");
  const platform = stringField(record, "platform");
  if (platform !== "linux-x64") {
    throw new BaselineError("Baseline field platform must be linux-x64");
  }
  const command = record.command;
  if (!isNonEmptyStringArray(command)) {
    throw new BaselineError("Baseline field command must be a non-empty string array");
  }
  const runs = numberField(record, "runs");
  if (!Number.isInteger(runs)) throw new BaselineError("Baseline field runs must be a positive integer");
  return {
    description: stringField(record, "description"),
    platform,
    command,
    runs,
    startupBudgetMs: numberField(record, "startupBudgetMs"),
    firstOutputBudgetMs: numberField(record, "firstOutputBudgetMs"),
  };
};

export const percentile95 = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) throw new Error("Cannot compute p95 without samples");
  const sorted = [...values].sort((left, right) => left - right);
  const value = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (value === undefined) throw new Error("Unable to compute p95");
  return value;
};
