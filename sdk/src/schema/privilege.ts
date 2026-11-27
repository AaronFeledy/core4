import { Schema } from "effect";

// ============================================================================
// Privilege credentials — how a privileged run would obtain administrator access.
// ============================================================================

export const PrivilegeCredentialState = Schema.Literals([
  "not-needed",
  "root",
  "cached",
  "askpass",
  "will-prompt",
  "required",
  "unavailable",
]).annotate({
  description:
    "`not-needed`: nothing in the run needs administrator access. `root`: Lando already runs as root. `cached`: sudo holds a valid ticket. `askpass`: `SUDO_ASKPASS` supplies the password. `will-prompt`: sudo asks for the password once in this terminal. `required`: the run cannot ask and has no ticket or askpass. `unavailable`: this host has no way to elevate.",
});
export type PrivilegeCredentialState = typeof PrivilegeCredentialState.Type;

export const PrivilegeCredentialStatus = Schema.Struct({
  state: PrivilegeCredentialState,
  detail: Schema.optionalKey(
    Schema.String.annotate({ description: "Why the state applies, and what to do when it blocks the run." }),
  ),
}).annotate({
  description: "How a run that needs administrator access would get it. Checking never prompts.",
});
export type PrivilegeCredentialStatus = typeof PrivilegeCredentialStatus.Type;
