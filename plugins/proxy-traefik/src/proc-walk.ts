import { readdir, readlink } from "node:fs/promises";

export const TCP_LISTEN = "0A";
/** Stay inside probeBudgetMs (min(5000, section/3) ≈ 3.3s) even with two leftover ports. */
export const COMM_SCAN_BUDGET_MS = 800;

export interface ProcWalk {
  readonly names: (path: string) => Promise<ReadonlyArray<string> | undefined>;
  readonly text: (path: string) => Promise<string | undefined>;
  readonly link: (path: string) => Promise<string | undefined>;
  readonly now?: () => number;
}

const optionalText = async (path: string): Promise<string | undefined> => {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const optionalNames = async (path: string): Promise<ReadonlyArray<string> | undefined> => {
  try {
    return await readdir(path);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

const optionalLink = async (path: string): Promise<string | undefined> => {
  try {
    return await readlink(path);
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
};

export const systemProcWalk: ProcWalk = {
  names: optionalNames,
  text: optionalText,
  link: optionalLink,
};

export const pastDeadline = (walk: ProcWalk, deadline: number): boolean =>
  (walk.now ?? Date.now)() >= deadline;
