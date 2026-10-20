import { Effect } from "effect";

import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Renderer } from "@lando/sdk/services";

import { isStdoutDumpArg } from "../dump-stdio.ts";
import { dbCommandRedactionTokens, dbInputFromCommand, runDbCommand } from "../run.ts";
import { type DbCommandResult, DbCommandResult as DbCommandResultSchema } from "../schemas.ts";

export const spec = {
  id: "db:export",
  summary: "Export a database dump from a service.",
  namespace: "db",
  bootstrap: "app",
  flags: {
    service: { type: "string", description: "Source database service." },
    yes: { type: "boolean", default: false, description: "Skip confirmation prompts." },
    "force-tty": {
      type: "boolean",
      default: false,
      description: "Allow writing a dump to stdout when stdout is a terminal.",
    },
  },
  args: {
    file: { type: "string", description: "Destination dump file, or - for stdout." },
  },
  resultSchema: DbCommandResultSchema,
  redactionTokens: dbCommandRedactionTokens,
  payloadStdout: (input) => isStdoutDumpArg(typeof input.args.file === "string" ? input.args.file : undefined),
  run: (input) => runDbCommand(dbInputFromCommand("export", input)),
  render: ({ input, result }) => {
    const file = typeof input.args.file === "string" ? input.args.file : undefined;
    if (!isStdoutDumpArg(file) || result.digest === undefined) return Effect.void;
    const size = result.sizeBytes === undefined ? "" : ` ${result.sizeBytes} bytes`;
    return Renderer.pipe(
      Effect.flatMap((renderer) => renderer.output.stderr(`sha256 ${result.digest}${size}\n`)),
    );
  },
} as const satisfies ExecutableCommandSpec<DbCommandResult>;
