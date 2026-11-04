import { Effect } from "effect";
import type { LanguageSource } from "../language/errors.ts";
import { planningError } from "./errors.ts";

export interface GraphJob {
  readonly id: string;
  readonly needs: readonly string[];
  readonly source?: LanguageSource;
}
export const validateJobGraph = (jobs: readonly GraphJob[], source?: LanguageSource) =>
  Effect.try({
    try: (): readonly string[] => {
      if (jobs.length > 256) throw planningError("job-limit", source);
      const byId = new Map<string, GraphJob>();
      for (const job of jobs) {
        if (byId.has(job.id)) throw planningError("duplicate-job", job.source ?? source);
        if (job.id.length > 256 || job.needs.length > 256) throw planningError("job-limit", source);
        byId.set(job.id, job);
      }
      for (const job of jobs)
        for (const need of job.needs) {
          if (need === job.id) throw planningError("self-needs", job.source ?? source);
          if (!byId.has(need)) throw planningError("unknown-needs", job.source ?? source);
        }
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const order: string[] = [];
      const visit = (id: string): void => {
        if (visiting.has(id)) throw planningError("needs-cycle", byId.get(id)?.source ?? source);
        if (visited.has(id)) return;
        visiting.add(id);
        for (const need of byId.get(id)?.needs ?? []) visit(need);
        visiting.delete(id);
        visited.add(id);
        order.push(id);
      };
      for (const job of jobs) visit(job.id);
      return order;
    },
    catch: (error) =>
      error instanceof Error && "_tag" in error && error._tag === "PlanningError"
        ? (error as ReturnType<typeof planningError>)
        : planningError("graph-invalid", source),
  });
