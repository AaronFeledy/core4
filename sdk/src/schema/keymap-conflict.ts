import { Either } from "effect";

import { KeymapConflictError } from "../errors/keymap.ts";

import {
  type KeymapConfig,
  type KeymapSurface,
  RENDERER_ACTION_SURFACE,
  type RendererActionId,
} from "./keymap.ts";

// ====
// Same-surface keymap conflict check (config-boundary step after KeymapConfig decode).
// SPEC: spec/08-cli-and-tooling.md §8.9.6

const chordsOf = (binding: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof binding === "string" ? [binding] : binding;

/**
 * After a successful `KeymapConfig` decode, reject same-surface chord collisions
 * with `KeymapConflictError`. Cross-surface chord reuse is allowed.
 */
export const validateKeymapConfigConflicts = (
  config: KeymapConfig,
): Either.Either<KeymapConfig, KeymapConflictError> => {
  const bySurface = new Map<KeymapSurface, Map<string, RendererActionId>>();

  for (const [action, binding] of Object.entries(config) as Array<
    [RendererActionId, KeymapConfig[RendererActionId]]
  >) {
    if (binding === undefined) continue;
    const surface = RENDERER_ACTION_SURFACE[action];
    let chordMap = bySurface.get(surface);
    if (chordMap === undefined) {
      chordMap = new Map();
      bySurface.set(surface, chordMap);
    }
    for (const chord of chordsOf(binding)) {
      const existing = chordMap.get(chord);
      if (existing !== undefined && existing !== action) {
        const actions = [existing, action].sort() as [RendererActionId, RendererActionId];
        return Either.left(
          new KeymapConflictError({
            surface,
            chord,
            actions,
            message: `Keymap chord "${chord}" is bound to both ${actions[0]} and ${actions[1]} on surface ${surface}.`,
            remediation: `Remove or change one same-surface binding so "${chord}" is unique within the ${surface} surface.`,
          }),
        );
      }
      chordMap.set(chord, action);
    }
  }

  return Either.right(config);
};
