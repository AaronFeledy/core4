/**
 * OCLIF `init` hook — Lando bootstrap.
 *
 * Sequence:
 *   1. Load global config + env overrides         [level: minimal]
 *   2. Discover Landofiles upward from CWD        [level: minimal]
 *   3. Load plugin manifest cache                 [level: plugins]
 *   4. Register OCLIF commands from cache         [level: commands]
 *   5. OCLIF resolves the command to run
 *   6. Read command's required BootstrapLevel
 *   7. Build LandoRuntimeLive Layer at that level
 *   8. Run the command's Effect program
 *
 * Each level emits `pre-bootstrap-<level>` and `post-bootstrap-<level>`
 * lifecycle events through the Effect event service. After all required
 * levels complete, core emits `post-bootstrap` and `ready`.
 *
 * Status: stub.
 */
import type { Hook } from "@oclif/core";

export const initHook: Hook<"init"> = async (_options) => {
  // TODO: execute the bootstrap sequence above.
};
