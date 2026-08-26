const OCCURRENCE_SEPARATOR = "\0";

export const occurrenceTaskId = (parentId: string, rawTaskId: string): string =>
  `${parentId}${OCCURRENCE_SEPARATOR}${rawTaskId}`;

export const parseOccurrenceTaskId = (
  internalId: string,
): { readonly parentId: string; readonly rawTaskId: string } | undefined => {
  const separator = internalId.indexOf(OCCURRENCE_SEPARATOR);
  if (separator <= 0 || separator === internalId.length - 1) return undefined;
  return { parentId: internalId.slice(0, separator), rawTaskId: internalId.slice(separator + 1) };
};

export const rawEventTaskId = (internalId: string): string =>
  parseOccurrenceTaskId(internalId)?.rawTaskId ?? internalId;
