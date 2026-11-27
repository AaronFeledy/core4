/**
 * One administrator session for a whole `lando setup` run. Approval opens it, after consent and
 * before the first change, when an approved change runs a step as root. Any later `openSession`
 * or `elevate` in the run reuses that session, or opens it when no approved change needed one. It
 * closes with the run, forgetting a ticket it created, so sudo asks at most once per run, however
 * many stages make host changes.
 */
import type { PrivilegeService, PrivilegeSession } from "@lando/sdk/services";
import { type Context, Effect, Scope, Semaphore } from "effect";

type PrivilegeServiceShape = Context.Service.Shape<typeof PrivilegeService>;

export const makeRunPrivilege = Effect.fnUntraced(function* (
  privilege: PrivilegeServiceShape,
): Effect.fn.Return<PrivilegeServiceShape, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  let session: PrivilegeSession | undefined;
  const openSession = (purpose: string) =>
    lock.withPermits(1)(
      Effect.suspend(() =>
        session === undefined
          ? privilege.openSession(purpose).pipe(
              Scope.provide(scope),
              Effect.tap((opened) =>
                Effect.sync(() => {
                  session = opened;
                }),
              ),
            )
          : Effect.succeed(session),
      ),
    );
  return {
    credentialStatus: privilege.credentialStatus,
    openSession,
    elevate: (command, options) =>
      openSession(`run ${command[0] ?? "a command"}`).pipe(
        Effect.flatMap((opened) => opened.elevate(command, options)),
      ),
  };
});
