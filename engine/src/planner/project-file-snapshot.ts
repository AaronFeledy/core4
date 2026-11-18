import type { AppPlan } from "@lando/sdk/schema";
import type { ProjectFileFingerprint } from "../cache/project-file-fingerprint.ts";
import type { ResolvedService } from "./service-types.ts";

// A receipt for this planning call, not applied state. Even a plan-cache hit
// carries the inputs just observed while resolving its service types.
const snapshot = Symbol("projectFileSnapshot");
type ObservedPlan = AppPlan & { readonly [snapshot]?: readonly ProjectFileFingerprint[] };

export const attachProjectFileSnapshot = <Plan extends AppPlan>(
  plan: Plan,
  services: readonly ResolvedService[],
): Plan & ObservedPlan => {
  const files = new Map<string, ProjectFileFingerprint>();
  const conflicts: ProjectFileFingerprint[] = [];
  for (const service of services) {
    for (const file of service.projectFiles) {
      const fingerprint: ProjectFileFingerprint = file.present
        ? { path: file.path, present: true, size: file.size, sha256: file.sha256 }
        : { path: file.path, present: false };
      const previous = files.get(file.path);
      if (previous === undefined) files.set(file.path, fingerprint);
      else if (
        previous.present !== file.present ||
        (previous.present && file.present && (previous.sha256 !== file.sha256 || previous.size !== file.size))
      ) {
        // A concurrent edit produced incompatible observations. Keep both so
        // the reader refuses to treat this index as fresh.
        conflicts.push(fingerprint);
      }
    }
  }
  return { ...plan, [snapshot]: [...files.values(), ...conflicts] };
};

export const projectFileSnapshotFor = (plan: ObservedPlan): readonly ProjectFileFingerprint[] =>
  plan[snapshot] ?? [];
