import { expressionDataFromUnknownSync } from "../../language/expressions.ts";

/** Reuse language's descriptor-safe JSON admission before taking an isolated private snapshot. */
export const snapshotSourceJson = <A>(input: A): A => {
  expressionDataFromUnknownSync(input, {
    limits: { valueBytes: 128 * 1024, valueNodes: 2000, valueDepth: 16 },
  });
  return JSON.parse(JSON.stringify(input)) as A;
};
