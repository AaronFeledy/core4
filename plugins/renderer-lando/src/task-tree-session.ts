import type { LandoEvent } from "@lando/sdk/services";

export type TaskTreeSession =
  | { readonly kind: "idle" }
  | { readonly kind: "armed"; readonly commandId: string; readonly invocationId: string }
  | {
      readonly kind: "open";
      readonly commandId: string;
      readonly invocationId: string;
      readonly committed: boolean;
    };

export type CliLifecycleKind = "init" | "terminal";

export type ClassifiedCliLifecycle = {
  readonly kind: CliLifecycleKind;
  readonly commandId: string;
  readonly invocationId: string;
  readonly nested: boolean;
};

const CLI_INIT = /^cli-(.+)-init$/;
const CLI_TERMINAL = /^cli-(.+)-(?:run|error)$/;

const stringField = (event: LandoEvent, key: string): string | undefined => {
  const value = Reflect.get(event, key);
  return typeof value === "string" ? value : undefined;
};

export const idleSession = (): TaskTreeSession => ({ kind: "idle" });

export const classifyCliLifecycle = (event: LandoEvent): ClassifiedCliLifecycle | undefined => {
  const init = CLI_INIT.exec(event._tag);
  const terminal = init === null ? CLI_TERMINAL.exec(event._tag) : null;
  const match = init ?? terminal;
  if (match === null) return undefined;
  const commandId = stringField(event, "commandId") ?? match[1];
  const invocationId = stringField(event, "invocationId");
  if (commandId === undefined || invocationId === undefined) return undefined;
  return {
    kind: init === null ? "terminal" : "init",
    commandId,
    invocationId,
    nested: stringField(event, "parentInvocationId") !== undefined,
  };
};

export const armSession = (session: TaskTreeSession, event: LandoEvent): TaskTreeSession => {
  const classified = classifyCliLifecycle(event);
  if (classified === undefined || classified.kind !== "init" || classified.nested) return session;
  return { kind: "armed", commandId: classified.commandId, invocationId: classified.invocationId };
};

export const openArmedSession = (session: TaskTreeSession): TaskTreeSession => {
  if (session.kind !== "armed") return session;
  return { kind: "open", commandId: session.commandId, invocationId: session.invocationId, committed: false };
};

export const matchesOuterTerminal = (session: TaskTreeSession, event: LandoEvent): boolean => {
  if (session.kind === "idle") return false;
  const classified = classifyCliLifecycle(event);
  return (
    classified !== undefined &&
    classified.kind === "terminal" &&
    !classified.nested &&
    classified.invocationId === session.invocationId
  );
};

export const markSessionCommitted = (session: TaskTreeSession): TaskTreeSession => {
  if (session.kind !== "open") return session;
  return { kind: "open", commandId: session.commandId, invocationId: session.invocationId, committed: true };
};

export const shouldFlushSessionOnDispose = (session: TaskTreeSession, hasTasks: boolean): boolean =>
  session.kind === "open" && !session.committed && hasTasks;

export type SessionBoundaryAction = "none" | "arm" | "commit" | "clear" | "ignore";

export type SessionBoundary = {
  readonly action: SessionBoundaryAction;
  readonly session: TaskTreeSession;
};

export const applyLifecycleBoundary = (session: TaskTreeSession, event: LandoEvent): SessionBoundary => {
  const classified = classifyCliLifecycle(event);
  if (classified === undefined) return { action: "none", session };
  if (classified.kind === "init" && !classified.nested) {
    return { action: "arm", session: armSession(session, event) };
  }
  if (matchesOuterTerminal(session, event)) {
    if (session.kind === "open") return { action: "commit", session };
    return { action: "clear", session: idleSession() };
  }
  return { action: "ignore", session };
};
