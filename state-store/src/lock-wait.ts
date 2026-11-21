import { StateStoreError } from "@lando/sdk/errors";
import type { LockWaitEvent, LockWaitHolder } from "@lando/sdk/events";
import { formatLockHolder, formatLockWaitPhrase, formatWaitDuration } from "@lando/sdk/renderer";
import { EventService, type StateLockOptions } from "@lando/sdk/services";
import { Clock, DateTime, Effect, Option } from "effect";
import { type AdvisoryLockRecord, peekAdvisoryLockRecord } from "./lock-record.ts";

const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const BRIEF_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 600_000;
const LOCK_TIMEOUT_ENV = "LANDO_LOCK_TIMEOUT_MS";
const validBudget = (value: number) => Number.isInteger(value) && value >= 0 && value <= MAX_TIMEOUT_MS;

// The first notice comes after a second of waiting, a reminder at 30s, then one a minute.
const SECOND_NS = 1_000_000_000n;
const FIRST_NOTICE_NS = SECOND_NS;
const SECOND_NOTICE_NS = 30n * SECOND_NS;
const REPEAT_NOTICE_NS = 60n * SECOND_NS;

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
      : BRIEF_TIMEOUT_MS;

export const holderDetails = (record: AdvisoryLockRecord | null, now: number) =>
  record === null ? {} : { ownerPid: record.pid, heldMs: Math.max(0, now - record.createdAt) };

const lockWaitHolder = (record: AdvisoryLockRecord, now: number): LockWaitHolder => ({
  pid: record.pid,
  heldMs: Math.max(0, now - record.createdAt),
  ...(record.command === undefined ? {} : { command: record.command }),
  ...(record.app === undefined ? {} : { app: record.app }),
});

const waitHolder = (record: AdvisoryLockRecord | null, now: number): LockWaitHolder | undefined =>
  record === null ? undefined : lockWaitHolder(record, now);

/** `lando start in alpha (pid 691865, running 16s)`, from the holder's diagnostic record. */
export const describeLockHolder = (record: AdvisoryLockRecord, now: number): string =>
  formatLockHolder(lockWaitHolder(record, now));

type WaitTarget = {
  readonly path: string;
  readonly operation: string;
  readonly resource: string;
  readonly timeoutMs: number;
  readonly wait: NonNullable<StateLockOptions["wait"]>;
  /** `app` when the lock stands for a whole app, so waiting means waiting for its command. */
  readonly subject: LockWaitEvent["subject"];
};

const describeLockWait = (target: WaitTarget, record: AdvisoryLockRecord | null, now: number): string => {
  const holder = waitHolder(record, now);
  return formatLockWaitPhrase({
    resource: target.resource,
    subject: target.subject,
    ...(holder === undefined ? {} : { holder }),
  });
};

const timeoutRemediation = (target: WaitTarget, record: AdvisoryLockRecord | null): string => {
  if (target.wait !== "operation")
    return record === null
      ? "Retry in a moment."
      : `This lock is normally released within moments. Retry; if it stays held, check whether process ${record.pid} is stuck.`;
  const budget = resolveOperationLockTimeoutMs();
  return budget === 0
    ? `${LOCK_TIMEOUT_ENV} is 0, so Lando did not wait. Unset it to wait up to ${formatWaitDuration(DEFAULT_OPERATION_TIMEOUT_MS)}, or retry once the other command finishes.`
    : `Retry once the other command finishes, or set ${LOCK_TIMEOUT_ENV} to wait longer than ${formatWaitDuration(budget)} (milliseconds, up to ${MAX_TIMEOUT_MS}).`;
};

export const lockTimeout = (
  target: WaitTarget,
  record: AdvisoryLockRecord | null,
  now: number,
): StateStoreError => {
  return new StateStoreError({
    path: target.path,
    operation: target.operation,
    resource: target.resource,
    timeoutMs: target.timeoutMs,
    ...holderDetails(record, now),
    reason: "lock",
    lockFailure: "timeout",
    message: `${target.timeoutMs > 0 ? `Gave up after ${formatWaitDuration(target.timeoutMs)} waiting` : "Did not wait"} for ${describeLockWait(target, record, now)}.`,
    remediation: timeoutRemediation(target, record),
  });
};

export const makeLockWait = Effect.fnUntraced(function* (target: WaitTarget, deadline: bigint) {
  const events = yield* Effect.serviceOption(EventService);
  let firstContention: bigint | undefined;
  let notices = 0;
  const remainingMs = (until: bigint, now: bigint) => Number(until - now) / 1_000_000;
  const noticeDue = (): bigint | undefined => {
    if (firstContention === undefined || Option.isNone(events)) return undefined;
    const offset =
      notices === 0 ? FIRST_NOTICE_NS : SECOND_NOTICE_NS + BigInt(notices - 1) * REPEAT_NOTICE_NS;
    return firstContention + offset;
  };
  const onContention = Effect.fnUntraced(function* () {
    const now = yield* Clock.monotonicTimeNanos;
    firstContention ??= now;
    const due = noticeDue();
    if (Option.isNone(events) || due === undefined || now < due || now >= deadline) return;
    const reminder = notices > 0;
    notices++;
    const holder = waitHolder(peekAdvisoryLockRecord(target.path), yield* Clock.currentTimeMillis);
    yield* events.value
      .publish({
        _tag: "lock.wait",
        resource: target.resource,
        subject: target.subject,
        ...(holder === undefined ? {} : { holder }),
        reminder,
        remainingMs: Math.max(0, Math.round(remainingMs(deadline, now))),
        timestamp: yield* DateTime.now,
      })
      .pipe(Effect.ignore, Effect.forkDetach);
  });

  return {
    onContention,
    remaining: Effect.map(Clock.monotonicTimeNanos, (now) => remainingMs(deadline, now)),
    untilNextWake: Effect.map(Clock.monotonicTimeNanos, (now) => {
      const due = noticeDue();
      return remainingMs(due !== undefined && due < deadline ? due : deadline, now);
    }),
    timeout: Effect.fnUntraced(function* () {
      return yield* lockTimeout(target, peekAdvisoryLockRecord(target.path), yield* Clock.currentTimeMillis);
    }),
  };
});
