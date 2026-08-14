export const dataAttributesOf = (
  props: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(props).filter(([name]) => name.startsWith("data-")));
