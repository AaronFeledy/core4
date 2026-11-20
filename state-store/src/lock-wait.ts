import { StateStoreError } from "@lando/sdk/errors";
import { EventService, type StateLockOptions } from "@lando/sdk/services";
import { Clock, DateTime, Effect, Option } from "effect";
import { type AdvisoryLockRecord, peekAdvisoryLockRecord } from "./lock-record.ts";

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const LOCK_TIMEOUT_ENV = "LANDO_LOCK_TIMEOUT_MS";
const validBudget = (value: number) => Number.isInteger(value) && value >= 0 && value <= 600_000;

export const resolveOperationLockTimeoutMs = (
  env: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const raw = env[LOCK_TIMEOUT_ENV]?.trim();
  if (raw === undefined || !/^\d+$/u.test(raw)) return DEFAULT_OPERATION_TIMEOUT_MS;
  const value = Number(raw);
  return validBudget(value) ? value : DEFAULT_OPERATION_TIMEOUT_MS;
};

export const lockWaitBudget = ({ wait, timeoutMs }: StateLockOptions): number =>
  timeoutMs !== undefined && validBudget(timeoutMs)
    ? timeoutMs
    : wait === "operation"
      ? resolveOperationLockTimeoutMs()
      : 2_000;

export const formatLockDuration = (ms: number): string =>
  ms < 1_000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`;

export const holderDetails = (record: AdvisoryLockRecord | null, now: number) =>
  record === null ? {} : { ownerPid: record.pid, heldMs: Math.max(0, now - record.createdAt) };

export const holderDescription = (details: ReturnType<typeof holderDetails>) =>
  details.ownerPid === undefined
    ? "another Lando command"
    : `process ${details.ownerPid} (held for ${formatLockDuration(details.heldMs)})`;

type WaitTarget = {
  readonly path: string;
  readonly operation: string;
  readonly resource: string;
  readonly timeoutMs: number;
};

export const lockTimeout = (
  input: WaitTarget,
  details: ReturnType<typeof holderDetails> = {},
): StateStoreError =>
  new StateStoreError({
    ...input,
    ...details,
    reason: "lock",
    lockFailure: "timeout",
    message: `Timed out after ${formatLockDuration(input.timeoutMs)} waiting for ${input.resource}, held by ${holderDescription(details)}.`,
    remediation: `Wait for the other command to finish, then retry. Set ${LOCK_TIMEOUT_ENV} (milliseconds) to wait longer for operation locks.`,
  });

export const makeLockWait = Effect.fnUntraced(function* (target: WaitTarget, deadline: bigint) {
  const events = yield* Effect.serviceOption(EventService);
  let noticeAt: bigint | undefined;
  let announced = false;
  const remainingMs = (until: bigint, now: bigint) => Number(until - now) / 1_000_000;
  const onContention = Effect.fnUntraced(function* () {
    const now = yield* Clock.monotonicTimeNanos;
    noticeAt ??= now + 1_000_000_000n;
    if (!announced && now >= noticeAt && now < deadline && Option.isSome(events)) {
      announced = true;
      const details = holderDetails(peekAdvisoryLockRecord(target.path), yield* Clock.currentTimeMillis);
      yield* events.value
        .publish({
          _tag: "message.warn",
          body: `Waiting for ${target.resource}, held by ${holderDescription(details)}.`,
          timestamp: yield* DateTime.now,
        })
        .pipe(Effect.ignore, Effect.forkDetach);
    }
  });

  return {
    onContention,
    remaining: Effect.map(Clock.monotonicTimeNanos, (now) => remainingMs(deadline, now)),
    untilNextWake: Effect.map(Clock.monotonicTimeNanos, (now) =>
      remainingMs(
        announced || Option.isNone(events) || noticeAt === undefined || noticeAt > deadline
          ? deadline
          : noticeAt,
        now,
      ),
    ),
    timeout: Effect.fnUntraced(function* () {
      const details = holderDetails(peekAdvisoryLockRecord(target.path), yield* Clock.currentTimeMillis);
      return yield* lockTimeout(target, details);
    }),
  };
});
