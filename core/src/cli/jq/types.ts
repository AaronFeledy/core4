export interface JqEngine {
  eval(input: unknown, expr: string): Promise<{ text: string }>;
}
