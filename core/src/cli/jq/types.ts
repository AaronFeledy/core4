export type JqEngineEvalOptions = {
  readonly signal?: AbortSignal;
};

export interface JqEngine {
  eval(input: unknown, expr: string, options?: JqEngineEvalOptions): Promise<{ text: string }>;
}
