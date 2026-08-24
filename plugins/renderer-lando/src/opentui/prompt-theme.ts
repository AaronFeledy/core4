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

export const promptSelectColors = {
  backgroundColor: PROMPT_THEME.background,
  textColor: PROMPT_THEME.text,
  focusedBackgroundColor: PROMPT_THEME.background,
  focusedTextColor: PROMPT_THEME.focusedText,
  selectedBackgroundColor: PROMPT_THEME.selectedBackground,
  selectedTextColor: PROMPT_THEME.selectedText,
  descriptionColor: PROMPT_THEME.muted,
  selectedDescriptionColor: PROMPT_THEME.text,
} as const;
