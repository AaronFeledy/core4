import { Either } from "effect";

import { KeymapConflictError } from "../errors/keymap.ts";

import {
  DEFAULT_KEYMAP_BINDINGS,
  type KeymapConfig,
  type KeymapSurface,
  RENDERER_ACTION_SURFACE,
  type RendererActionId,
  type RendererKeyBinding,
} from "./keymap.ts";

// ====
// Same-surface keymap conflict check (config-boundary step after KeymapConfig decode).

const chordsOf = (binding: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof binding === "string" ? [binding] : binding;

const resolvedBinding = (config: KeymapConfig, action: RendererActionId): RendererKeyBinding =>
  config[action] ?? DEFAULT_KEYMAP_BINDINGS[action];

/**
 * After a successful `KeymapConfig` decode, reject same-surface chord collisions
 * with `KeymapConflictError`. Cross-surface chord reuse is allowed. Omitted
 * actions keep their frozen defaults so an override that collides with another
 * action's retained default is still rejected.
 */
export const validateKeymapConfigConflicts = (
  config: KeymapConfig,
): Either.Either<KeymapConfig, KeymapConflictError> => {
  const bySurface = new Map<KeymapSurface, Map<string, RendererActionId>>();

  for (const action of Object.keys(RENDERER_ACTION_SURFACE) as Array<RendererActionId>) {
    const binding = resolvedBinding(config, action);
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
