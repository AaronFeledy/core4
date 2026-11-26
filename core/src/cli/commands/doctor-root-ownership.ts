import { scanRootOwnership } from "@lando/engine/host/root-ownership";
import { PathsService } from "@lando/sdk/services";
import { Effect } from "effect";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";

const CHECK = "root-owned-entries";

/** Reports root-owned entries under Lando's roots, usually left by running Lando with sudo. */
export const rootOwnershipDoctor = Effect.fnUntraced(function* (redact: (text: string) => string) {
  const paths = yield* PathsService;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) return [];
  const scan = yield* scanRootOwnership({ paths, uid, gid });
  const owned = scan.rootOwned.map((entry) =>
    failCheck({
      name: CHECK,
      subject: redact(entry.path),
      recovery: "manual",
      context: { path: redact(entry.path) },
      solutions: [
        {
          kind: "manual",
          description: redact(
            `${entry.path} belongs to root, so Lando cannot write it. This usually happens after running lando with sudo. Give it back to your user, then run lando without sudo: Lando asks for administrator access itself when a step needs it.`,
          ),
          command: redact(entry.remediation),
        },
      ],
    }),
  );
  if (scan.incomplete.length > 0) {
    return [
      ...owned,
      warnCheck({
        name: CHECK,
        recovery: "manual",
        context: { incomplete: scan.incomplete.map(redact) },
        solutions: [
          {
            kind: "manual",
            description: redact(
              `Doctor could not inspect every Lando file for root ownership (${scan.incomplete.join("; ")}). Check these paths yourself, or rerun lando doctor.`,
            ),
          },
        ],
      }),
    ];
  }
  return owned.length > 0 ? owned : [passCheckNamed({ name: CHECK, context: {} })];
});
