export interface EditorRunInput {
  readonly name: string;
  readonly content: string;
  readonly cwd: string;
}

export type EditorRunResult =
  | { readonly kind: "edited"; readonly content: string }
  | { readonly kind: "no-editor" }
  | { readonly kind: "failed"; readonly reason: string; readonly exitCode?: number };

export type EditorRunner = (input: EditorRunInput) => Promise<EditorRunResult>;
