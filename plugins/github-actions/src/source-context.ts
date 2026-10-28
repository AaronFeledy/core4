import { type LineCounter, isMap, isScalar, isSeq } from "yaml";
import type { DiagnosticField } from "./schema.ts";

interface Site {
  readonly start: number;
  readonly end: number;
  readonly path: readonly DiagnosticField[];
  readonly kind: "mapping" | "key" | "value";
}
export interface WorkflowSourceIndex {
  readonly sites: readonly Site[];
  readonly lines: readonly number[];
}

export const indexWorkflowSource = (contents: unknown, counter: LineCounter): WorkflowSourceIndex => {
  const sites: Site[] = [];
  const pending: {
    readonly value: unknown;
    readonly path: readonly DiagnosticField[];
    readonly role: "workflow" | "job" | "step";
  }[] = [{ value: contents, path: ["workflow"], role: "workflow" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || !isMap(current.value)) continue;
    const mapping = current.value;
    if (mapping.range !== undefined && mapping.range !== null)
      sites.push({ start: mapping.range[0], end: mapping.range[1], path: current.path, kind: "mapping" });
    const allowed: readonly DiagnosticField[] =
      current.role === "workflow"
        ? ["name", "on", "jobs"]
        : current.role === "job"
          ? ["name", "runs-on", "needs", "steps", "strategy", "uses"]
          : ["name", "uses", "run"];
    for (const pair of mapping.items) {
      const key = isScalar(pair.key) ? pair.key.value : undefined;
      const field = allowed.find((value) => value === key);
      const path = field === undefined ? current.path : [...current.path, field];
      if (isScalar(pair.key) && pair.key.range !== undefined && pair.key.range !== null)
        sites.push({ start: pair.key.range[0], end: pair.key.range[1], path, kind: "key" });
      if (
        (isScalar(pair.value) || isMap(pair.value) || isSeq(pair.value)) &&
        pair.value.range !== undefined &&
        pair.value.range !== null
      )
        sites.push({ start: pair.value.range[0], end: pair.value.range[1], path, kind: "value" });
      if (current.role === "workflow" && key === "jobs" && isMap(pair.value)) {
        for (const job of pair.value.items) pending.push({ value: job.value, path, role: "job" });
      }
      if (current.role === "job" && key === "steps" && isSeq(pair.value)) {
        for (const step of pair.value.items) pending.push({ value: step, path, role: "step" });
      }
    }
  }
  return { sites, lines: counter.lineStarts };
};

export const sourceContext = (
  index: WorkflowSourceIndex,
  position: { readonly line: number; readonly column: number } | undefined,
  mapping = false,
) => {
  const start = position === undefined ? undefined : index.lines[position.line - 1];
  const offset = start === undefined || position === undefined ? undefined : start + position.column - 1;
  let best: Site | undefined;
  if (offset !== undefined)
    for (const site of index.sites) {
      if (offset < site.start || offset >= site.end || (mapping && site.kind !== "mapping")) continue;
      if (
        best === undefined ||
        site.path.length > best.path.length ||
        (site.path.length === best.path.length && site.kind === "key" && site.start === offset)
      )
        best = site;
    }
  return { path: best?.path ?? ["workflow"], key: best?.kind === "key" && best.start === offset } satisfies {
    readonly path: readonly DiagnosticField[];
    readonly key: boolean;
  };
};
