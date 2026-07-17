import { Either, Schema } from "effect";

import { ConfigError } from "../errors/config.ts";

// ====
// Keymap action vocabulary and bindings (override schema + frozen defaults).

/**
 * Closed renderer action ids. Surfaces are mutually exclusive input contexts;
 * a chord may be reused across surfaces without conflict.
 */
export const RendererActionId = Schema.Literal(
  "tree.focus-prev",
  "tree.focus-next",
  "tree.cycle",
  "tree.expand",
  "tree.collapse",
  "prompt.cancel",
  "viewer.scroll-up",
  "viewer.scroll-down",
  "viewer.follow",
  "viewer.source-next",
  "viewer.quit",
  "keymap.help",
);
export type RendererActionId = typeof RendererActionId.Type;

/** Frozen key-name vocabulary (all lowercase; punctuation by name only). */
export const RendererKeyName = Schema.Literal(
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "up",
  "down",
  "left",
  "right",
  "tab",
  "enter",
  "escape",
  "space",
  "backspace",
  "delete",
  "home",
  "end",
  "page-up",
  "page-down",
  "insert",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
  "question-mark",
  "slash",
  "minus",
  "plus",
  "period",
  "comma",
  "semicolon",
  "backtick",
);
export type RendererKeyName = typeof RendererKeyName.Type;

/**
 * Canonical chord shape: optional `ctrl+`, then `alt+`, then `shift+`, then one key name.
 * All lowercase; no normalization — only this order is accepted.
 */
export const RendererKeyChordPattern = /^(ctrl\+)?(alt\+)?(shift\+)?[a-z0-9][a-z0-9-]*$/;

/**
 * A single key chord. Rejects unknown key names and reserved `ctrl+c` as ordinary
 * schema-decode failures (surfaced as `ConfigError` at the config boundary).
 */
export const RendererKeyChord = Schema.String.pipe(
  Schema.pattern(RendererKeyChordPattern),
  Schema.filter((chord) => Schema.is(RendererKeyName)(chord.replace(/^(ctrl\+)?(alt\+)?(shift\+)?/, "")), {
    message: () => "unknown key name",
  }),
  Schema.filter((chord) => chord !== "ctrl+c", {
    message: () => "ctrl+c is reserved and can never be bound",
  }),
);
export type RendererKeyChord = typeof RendererKeyChord.Type;

/**
 * One chord, or an array of 1..4 distinct chords for a single action.
 */
export const RendererKeyBinding = Schema.Union(
  RendererKeyChord,
  Schema.Array(RendererKeyChord).pipe(
    Schema.minItems(1),
    Schema.maxItems(4),
    Schema.filter((chords) => new Set(chords).size === chords.length, {
      message: () => "duplicate chord for one action",
    }),
  ),
);
export type RendererKeyBinding = typeof RendererKeyBinding.Type;

const bindingField = (description: string) =>
  Schema.optional(RendererKeyBinding).annotations({ description });

/**
 * Closed keymap override struct. Every action is optional (omitted keeps frozen default).
 * Intentionally plain — no root-level `Schema.filter` — so the published JSON Schema stays intact.
 * Same-surface chord conflicts are checked by validateKeymapConfigConflicts after decode.
 */
export const KeymapConfig = Schema.Struct({
  "tree.focus-prev": bindingField("Optional override chords for tree.focus-prev (task-tree surface)."),
  "tree.focus-next": bindingField("Optional override chords for tree.focus-next (task-tree surface)."),
  "tree.cycle": bindingField("Optional override chords for tree.cycle (task-tree surface)."),
  "tree.expand": bindingField("Optional override chords for tree.expand (task-tree surface)."),
  "tree.collapse": bindingField("Optional override chords for tree.collapse (task-tree surface)."),
  "prompt.cancel": bindingField("Optional override chords for prompt.cancel (prompt surface)."),
  "viewer.scroll-up": bindingField("Optional override chords for viewer.scroll-up (viewer surface)."),
  "viewer.scroll-down": bindingField("Optional override chords for viewer.scroll-down (viewer surface)."),
  "viewer.follow": bindingField("Optional override chords for viewer.follow (viewer surface)."),
  "viewer.source-next": bindingField("Optional override chords for viewer.source-next (viewer surface)."),
  "viewer.quit": bindingField("Optional override chords for viewer.quit (viewer surface)."),
  "keymap.help": bindingField("Optional override chords for keymap.help (keymap overlay surface)."),
});
export type KeymapConfig = typeof KeymapConfig.Type;

/** Frozen default bindings for every renderer action. */
export const DEFAULT_KEYMAP_BINDINGS = {
  "tree.focus-prev": "up",
  "tree.focus-next": "down",
  "tree.cycle": "tab",
  "tree.expand": "enter",
  "tree.collapse": "escape",
  "prompt.cancel": "escape",
  "viewer.scroll-up": "page-up",
  "viewer.scroll-down": "page-down",
  "viewer.follow": "f",
  "viewer.source-next": "s",
  "viewer.quit": "q",
  "keymap.help": "question-mark",
} as const satisfies Record<RendererActionId, string>;

/** Surface ownership for same-surface conflict detection. */
export const RENDERER_ACTION_SURFACE = {
  "tree.focus-prev": "task-tree",
  "tree.focus-next": "task-tree",
  "tree.cycle": "task-tree",
  "tree.expand": "task-tree",
  "tree.collapse": "task-tree",
  "prompt.cancel": "prompt",
  "viewer.scroll-up": "viewer",
  "viewer.scroll-down": "viewer",
  "viewer.follow": "viewer",
  "viewer.source-next": "viewer",
  "viewer.quit": "viewer",
  "keymap.help": "keymap",
} as const satisfies Record<RendererActionId, "task-tree" | "prompt" | "viewer" | "keymap">;

export type KeymapSurface = (typeof RENDERER_ACTION_SURFACE)[RendererActionId];

/**
 * Decode a raw keymap value. Per-value failures become ConfigError with path/message.
 * Does not check same-surface collisions — use validateKeymapConfigConflicts.
 */
export const decodeKeymapConfig = (input: unknown): Either.Either<KeymapConfig, ConfigError> => {
  const decoded = Schema.decodeUnknownEither(KeymapConfig)(input);
  if (Either.isRight(decoded)) return Either.right(decoded.right);

  const issue = decoded.left;
  const message =
    issue instanceof Error
      ? issue.message
      : typeof issue === "object" && issue !== null && "message" in issue
        ? String((issue as { message: unknown }).message)
        : "KeymapConfig decode failed";
  return Either.left(
    new ConfigError({
      message,
      path: "keymap",
      cause: issue,
    }),
  );
};
