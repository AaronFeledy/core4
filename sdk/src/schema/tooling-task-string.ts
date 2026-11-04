export const toolingTaskStringConstraints = {
  minLength: 1,
  not: { const: "disabled" },
} as const;
