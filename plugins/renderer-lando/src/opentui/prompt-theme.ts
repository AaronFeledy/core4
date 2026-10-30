import type { OpenTuiModuleLike, RendererLike } from "./prompt-driver-types.ts";

/**
 * Prompt chrome tokens. `accent` is Lando's primary brand pink (`#df4090`).
 */
export const PROMPT_THEME = {
  accent: "#df4090",
  background: "#282a36",
  text: "#fce7f3",
  focusedText: "#ffffff",
  selectedBackground: "#df4090",
  selectedText: "#ffffff",
  muted: "#f9a8d4",
  issue: "#f59e0b",
  placeholder: "#64748b",
  inputBackground: "#0f172a",
  inputFocusedBackground: "#1a1020",
} as const;

export type PromptTheme = { readonly [K in keyof typeof PROMPT_THEME]: string | object };

export type PromptModuleLike<R extends RendererLike = RendererLike> = OpenTuiModuleLike<R> & {
  readonly theme: PromptTheme;
};

export const createPromptTheme = (mod: OpenTuiModuleLike, noColor: boolean): PromptTheme => {
  if (!noColor) return PROMPT_THEME;
  const foreground = mod.RGBA.defaultForeground();
  const background = mod.RGBA.defaultBackground();
  return {
    accent: foreground,
    background,
    text: foreground,
    focusedText: foreground,
    selectedBackground: background,
    selectedText: foreground,
    muted: foreground,
    issue: foreground,
    placeholder: foreground,
    inputBackground: background,
    inputFocusedBackground: background,
  };
};

export const promptSelectColors = (theme: PromptTheme) => ({
  backgroundColor: theme.background,
  textColor: theme.text,
  focusedBackgroundColor: theme.background,
  focusedTextColor: theme.focusedText,
  selectedBackgroundColor: theme.selectedBackground,
  selectedTextColor: theme.selectedText,
  descriptionColor: theme.muted,
  selectedDescriptionColor: theme.text,
});
