import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { Option, Schema } from "effect";
import { LOCK_HOLDER_LABEL_MAX } from "./lock-holder.ts";
import { checkSentinel } from "./native-lock.ts";

const LockRecord = Schema.Struct({
  pid: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2_147_483_647 })),
  token: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  createdAt: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  resource: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  command: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(LOCK_HOLDER_LABEL_MAX))),
  app: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(LOCK_HOLDER_LABEL_MAX))),
});
export type AdvisoryLockRecord = typeof LockRecord.Type;
const parseRecord = Schema.decodeUnknownOption(Schema.fromJsonString(LockRecord), {
  onExcessProperty: "error",
});

export const peekAdvisoryLockRecord = (path: string): AdvisoryLockRecord | null => {
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      checkSentinel(fstatSync(fd));
      const bytes = Buffer.alloc(4096);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      return count === bytes.length ? null : Option.getOrNull(parseRecord(bytes.toString("utf8", 0, count)));
    } finally {
      closeSync(fd);
    }
  } catch (cause) {
    if (cause instanceof Error) return null;
    throw cause;
  }
};
