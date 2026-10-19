import { Schema } from "effect";

// ============================================================================
// Secondary failure roles
// ============================================================================
export const FailureRole = Schema.Literals(["rollback", "cleanup", "peer"]);
export type FailureRole = typeof FailureRole.Type;
