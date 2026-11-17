import { provenanceOf as provenanceIn } from "../src/provenance.ts";

export { provenanceIn };

export const includeSourcesOf = (value: object) => provenanceIn(value)?.includeSources ?? [];
export const localIncludePathsOf = (value: object) => provenanceIn(value)?.localIncludePaths ?? [];
export const internalToolingTasksOf = (value: object) => provenanceIn(value)?.internalToolingTasks ?? [];
