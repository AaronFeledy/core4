import { peekAdvisoryLockRecord } from "@lando/state-store/lock";
import { Effect } from "effect";
import { withDetachedWorkerLock } from "../../../../src/subsystems/detached-worker/state-file.ts";

const [path, userDataRoot] = process.argv.slice(2);
if (path === undefined || userDataRoot === undefined || process.send === undefined)
  throw new TypeError("Expected worker path, data root, and IPC channel");
const send = process.send.bind(process);
await Effect.runPromise(
  withDetachedWorkerLock(
    {
      path,
      paths: { userDataRoot },
      label: "host-proxy-worker",
      privateFileAccess: {
        enforce: async () => undefined,
        verify: async (lockPath) => {
          const record = await peekAdvisoryLockRecord(lockPath);
          if (record !== null && record.pid !== process.pid) send("held");
        },
      },
    },
    Effect.sync(() => {
      process.stdout.write("entered\n");
    }),
  ),
);
process.disconnect?.();
