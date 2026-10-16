let activeProcessAbortSignal: AbortSignal | undefined;

export const getActiveProcessAbortSignal = (): AbortSignal | undefined => activeProcessAbortSignal;

export const setActiveProcessAbortSignal = (signal: AbortSignal | undefined): AbortSignal | undefined => {
  const previous = activeProcessAbortSignal;
  activeProcessAbortSignal = signal;
  return previous;
};
