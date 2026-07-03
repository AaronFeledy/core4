/**
 * Compatibility re-export: the task-tree keyboard-input controller now lives in
 * the bundled `@lando/renderer-lando` plugin, which owns the default renderer
 * implementation. Core's verbose TTY mode and the renderer test suite continue
 * to import it from this path.
 */
export * from "@lando/renderer-lando/keybindings";
