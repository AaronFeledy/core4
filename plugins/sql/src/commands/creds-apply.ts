import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import {
  DatabaseCredentialConvergence,
  DatabaseCredentialConvergenceResult,
  InteractionService,
  Renderer,
  UserAppResolver,
} from "@lando/sdk/services";
import { Effect } from "effect";
import { readAdminPassword } from "../admin-password.ts";

export const spec = {
  id: "db:creds:apply",
  namespace: "db",
  bootstrap: "app",
  summary: "Preview or repair credentials for a running database service.",
  flags: {
    service: { type: "string", description: "Target database service." },
    yes: { type: "boolean", default: false, description: "Apply the previewed changes." },
    "admin-user": { type: "string", description: "Existing PostgreSQL or MongoDB administrator login." },
  },
  args: {
    adminPasswordSource: {
      type: "string",
      options: ["-"],
      stdio: "stdin",
      description: "Fallback database administrator password source.",
    },
  },
  resultSchema: DatabaseCredentialConvergenceResult,
  run: Effect.fn("Sql.reconcileDatabaseCredentials")(function* (input) {
    const resolver = yield* UserAppResolver;
    const { context } = yield* resolver.current;
    const convergence = yield* DatabaseCredentialConvergence;
    const interaction = yield* InteractionService;
    const service = typeof input.flags.service === "string" ? input.flags.service : undefined;
    const adminUser = typeof input.flags["admin-user"] === "string" ? input.flags["admin-user"] : undefined;
    return yield* convergence.reconcile({
      root: context.appRoot,
      apply: input.flags.yes === true,
      ...(service === undefined ? {} : { service }),
      ...(adminUser === undefined ? {} : { adminUser }),
      readPassword: readAdminPassword(input).pipe(
        Effect.provideService(InteractionService, interaction),
        Effect.scoped,
      ),
    });
  }),
  render: Effect.fnUntraced(function* ({ result }) {
    const renderer = yield* Renderer;
    if (result.outcome === "already-matched") {
      return yield* renderer.output.stdout("Database credentials already match the Landofile.\n");
    }
    const preview = result.outcome === "planned";
    const fields = result.changedMembers.join(", ");
    const lines = [
      `${preview ? "Would repair" : "Repaired"} database credentials for ${result.service}${fields ? `: ${fields}` : ""}.`,
    ];
    if (result.databaseCreation !== undefined) {
      lines.push(
        `${preview ? "Would create" : "Created"} the empty database ${result.databaseCreation.database}. Existing data stays where it is.`,
      );
    }
    if (result.adminAdoption === true) {
      lines.push(`${preview ? "Would install" : "Installed"} the Lando-managed database administrator.`);
    }
    if (preview) lines.push("Use --yes to apply.");
    if (result.next !== undefined)
      lines.push(`Run \`${result.next}\` to refresh Lando-managed container configuration.`);
    return yield* renderer.output.stdout(`${lines.join("\n")}\n`);
  }),
} as const satisfies ExecutableCommandSpec<DatabaseCredentialConvergenceResult>;
