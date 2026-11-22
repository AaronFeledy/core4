import { Effect } from "effect";
import { classifyAdminFailure, firstTrimmedLine, step } from "./client.ts";
import { postgresAdminAdoptionBlockedSql, postgresManagedAdminProofSql } from "./postgres-admin-policy.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialAdapter,
  CredentialStep,
} from "./types.ts";

const SOCKET = "/var/run/postgresql";
const MAINTENANCE_DB = "postgres";
const NAME_MAX = 63;
const SYSTEM_DATABASES = new Set(["template0", "template1"]);
const CONNECT_TIMEOUT = "3";

const isSafeName = (value: string): boolean =>
  value.length > 0 &&
  value.length <= NAME_MAX &&
  !/[\p{Cc}\p{Cs}=]/u.test(value) &&
  !value.includes("\x00") &&
  new TextEncoder().encode(value).length <= NAME_MAX;

const isLoopback = (host: string): boolean =>
  host === "127.0.0.1" ||
  host === "::1" ||
  host === "localhost" ||
  host.startsWith("127.") ||
  host === "0.0.0.0";

/** Double-quote a role for psql \password; reject controls already gated by isSafeName. */
const passwordMetaRole = (role: string): string => `"${role.replaceAll('"', '""')}"`;

const envFor = (password: string | undefined): Record<string, string> => ({
  PGCONNECT_TIMEOUT: CONNECT_TIMEOUT,
  ...(password === undefined || password.length === 0 ? {} : { PGPASSWORD: password }),
});

type Transport = {
  readonly host: string;
  readonly password: string | undefined;
};

/**
 * Socket trust is the stock admin path. An explicit stdin password must prove itself over TCP
 * (and keep that path for later admin/DDL), because the local socket and loopback host lines trust.
 */
const transportFor = (context: AdapterContext, admin: AdminCredential): Transport =>
  admin.explicit === true
    ? { host: context.host, password: admin.password }
    : { host: SOCKET, password: admin.password.length === 0 ? undefined : admin.password };

const baseArgv = (context: AdapterContext, user: string, host: string): string[] => [
  "psql",
  "-X",
  "-w",
  "-v",
  "ON_ERROR_STOP=1",
  "-At",
  "-F",
  "\t",
  "-h",
  host,
  "-p",
  String(context.port),
  "-U",
  user,
  "-d",
  MAINTENANCE_DB,
];

const sqlRequest = (
  context: AdapterContext,
  admin: AdminCredential,
  options: {
    readonly sql: string;
    readonly vars?: ReadonlyArray<readonly [string, string]>;
  },
): ClientRequest => {
  const transport = transportFor(context, admin);
  return {
    argv: [
      ...baseArgv(context, admin.user, transport.host),
      ...(options.vars ?? []).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
      ...(options.vars === undefined ? ["-c", options.sql] : []),
    ],
    env: envFor(transport.password),
    ...(options.vars === undefined ? {} : { stdin: `${options.sql};\n` }),
  };
};

const passwordRequest = (
  context: AdapterContext,
  admin: AdminCredential,
  role: string,
  password: string,
): ClientRequest => {
  const transport = transportFor(context, admin);
  return {
    argv: [...baseArgv(context, admin.user, transport.host), "-c", `\\password ${passwordMetaRole(role)}`],
    env: envFor(transport.password),
    stdin: `${password}\n${password}\n`,
  };
};

const loginRequest = (
  context: AdapterContext,
  options: {
    readonly user: string;
    readonly password: string;
    readonly host: string;
  },
): ClientRequest => ({
  argv: [...baseArgv(context, options.user, options.host), "-c", "SELECT 1"],
  env: envFor(options.password),
});

const privilegeDenied = (result: ClientResult): boolean =>
  /permission denied/iu.test(result.stderr) ||
  /must be (?:superuser|owner)/iu.test(result.stderr) ||
  /insufficient.?privilege/iu.test(result.stderr);

/**
 * When a TCP login is the only proof that a password is current, reject a synthetic wrong
 * password too. Acceptance of the control means trust (or equivalent) is masking auth.
 */
const provePasswordNotTrust = Effect.fnUntraced(function* (
  context: AdapterContext,
  options: { readonly user: string; readonly password: string; readonly host: string },
): Effect.fn.Return<"matched" | "mismatch", ReturnType<AdapterContext["failure"]>> {
  if (isLoopback(options.host)) {
    return yield* Effect.fail(
      context.failure(
        "PostgreSQL password proof requires a non-loopback container address; local trust would mask authentication.",
      ),
    );
  }
  const good = yield* context.run(
    loginRequest(context, {
      user: options.user,
      password: options.password,
      host: options.host,
    }),
  );
  if (good.state === "rejected") return "mismatch";
  if (good.state !== "accepted" || good.exitCode !== 0) {
    return yield* Effect.fail(
      context.failure("Could not prove the desired password over TCP.", good.exitCode),
    );
  }
  // Distinct from the desired secret; never equal under normal lengths. Clock-free for pure tests.
  const safeControl = `lando-trust-control-${options.password.length + 17}-${options.user.length + 3}-x`;
  const control = yield* context.run(
    loginRequest(context, {
      user: options.user,
      password: safeControl,
      host: options.host,
    }),
  );
  if (control.state === "rejected") return "matched";
  if (control.state === "accepted" && control.exitCode === 0) {
    return yield* Effect.fail(
      context.failure(
        "PostgreSQL accepted a non-matching password over TCP; host-based trust is masking authentication. Adjust pg_hba or supply a real TCP auth path before retrying.",
      ),
    );
  }
  return yield* Effect.fail(
    context.failure(
      "Could not complete the PostgreSQL wrong-password control over TCP; a timeout is not proof.",
      control.exitCode,
    ),
  );
});

export const postgres = (context: AdapterContext): CredentialAdapter => {
  if (context.family !== "postgres") {
    return {
      admin: () => Effect.fail(context.failure("postgres adapter only serves postgres.")),
      delta: () => Effect.fail(context.failure("postgres adapter only serves postgres.")),
    };
  }

  const admin = Effect.fnUntraced(function* (
    candidate: AdminCredential,
  ): Effect.fn.Return<
    "accepted" | "rejected" | "insufficient-privilege",
    ReturnType<AdapterContext["failure"]>
  > {
    if (!isSafeName(candidate.user)) return "rejected";
    if (candidate.explicit === true && isLoopback(context.host)) {
      return yield* Effect.fail(
        context.failure(
          "An explicit administrator password must be proved over non-loopback TCP; the stock image trusts the local socket and loopback.",
        ),
      );
    }
    const result = yield* context.run(
      sqlRequest(context, candidate, {
        sql: "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
      }),
    );
    if (result.exitCode !== 0 || result.state !== "accepted") {
      return yield* classifyAdminFailure(context, result, privilegeDenied);
    }
    const superuser = firstTrimmedLine(result.stdout);
    if (superuser === "t" || superuser === "true") return "accepted";
    if (superuser.length > 0) return "insufficient-privilege";
    return yield* Effect.fail(
      context.failure("Could not read rolsuper for the connected PostgreSQL role.", result.exitCode),
    );
  });

  const delta = Effect.fnUntraced(function* (
    adminCredential: AdminCredential,
  ): Effect.fn.Return<readonly CredentialStep[], ReturnType<AdapterContext["failure"]>> {
    const { desired } = context;
    if (
      !isSafeName(desired.user) ||
      !isSafeName(desired.database) ||
      /^postgres(?:ql)?:\/\//u.test(desired.database)
    ) {
      return yield* Effect.fail(
        context.failure("The desired database or login name cannot be represented safely."),
      );
    }
    if (SYSTEM_DATABASES.has(desired.database)) {
      return yield* Effect.fail(
        context.failure(
          `Refusing to create or retarget the reserved PostgreSQL database ${desired.database}.`,
        ),
      );
    }
    // Every PostgreSQL apply ends with a TCP password proof, so refuse before any write when the
    // container has no non-loopback address; the stock image trusts loopback and the socket.
    if (isLoopback(context.host)) {
      return yield* Effect.fail(
        context.failure(
          "PostgreSQL credential apply needs the container's non-loopback address to prove passwords; the stock image trusts loopback and the local socket.",
        ),
      );
    }

    // role_exists | db_exists — positive catalog evidence only (never classifier database-missing).
    const inventory = yield* context.run(
      sqlRequest(context, adminCredential, {
        vars: [
          ["u", desired.user],
          ["db", desired.database],
        ],
        sql: [
          "SELECT",
          "  EXISTS(SELECT 1 FROM pg_roles WHERE rolname = :'u')::text,",
          "  EXISTS(SELECT 1 FROM pg_database WHERE datname = :'db')::text",
        ].join(" "),
      }),
    );
    if (inventory.state === "rejected") {
      return yield* Effect.fail(
        context.failure(
          "Administrator authentication failed while reading the catalog.",
          inventory.exitCode,
          "transient",
        ),
      );
    }
    if (inventory.exitCode !== 0) {
      if (privilegeDenied(inventory)) {
        return yield* Effect.fail(
          context.failure(
            "Administrator lacks privilege to inspect roles and databases.",
            inventory.exitCode,
          ),
        );
      }
      return yield* Effect.fail(
        context.failure("Could not inspect the PostgreSQL catalog.", inventory.exitCode),
      );
    }
    const pair = firstTrimmedLine(inventory.stdout);
    const parts = pair.split("\t");
    if (
      parts.length !== 2 ||
      parts.some((value) => value !== "true" && value !== "false" && value !== "t" && value !== "f")
    ) {
      return yield* Effect.fail(context.failure("Unexpected PostgreSQL catalog inventory shape."));
    }
    const asBool = (value: string | undefined): boolean => value === "t" || value === "true";
    const roleExists = asBool(parts[0]);
    const databaseExists = asBool(parts[1]);

    if (desired.database === MAINTENANCE_DB && !databaseExists) {
      return yield* Effect.fail(
        context.failure(
          "The maintenance database postgres is missing; refusing to create it as an application database.",
        ),
      );
    }

    const steps: CredentialStep[] = [];

    if (!roleExists) {
      steps.push(
        step(
          ["user", "password"],
          sqlRequest(context, adminCredential, {
            vars: [["u", desired.user]],
            sql: 'CREATE ROLE :"u" LOGIN SUPERUSER',
          }),
        ),
      );
      steps.push(
        step(["password"], passwordRequest(context, adminCredential, desired.user, desired.password)),
      );
    }

    if (!databaseExists) {
      steps.push(
        step(
          ["database"],
          sqlRequest(context, adminCredential, {
            vars: [
              ["db", desired.database],
              ["u", desired.user],
            ],
            sql: 'CREATE DATABASE :"db" OWNER :"u"',
          }),
        ),
      );
    }
    if (
      roleExists &&
      (yield* provePasswordNotTrust(context, {
        user: desired.user,
        password: desired.password,
        host: context.host,
      })) === "mismatch"
    ) {
      steps.push(
        step(["password"], passwordRequest(context, adminCredential, desired.user, desired.password)),
      );
    }

    return steps;
  });

  const prove = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(context, candidate, {
        sql: `SELECT ${postgresManagedAdminProofSql}`,
      }),
    );
    return result.exitCode === 0 && firstTrimmedLine(result.stdout) === "t";
  });
  const adoption = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(context, candidate, {
        sql: `SELECT ${postgresAdminAdoptionBlockedSql}`,
      }),
    );
    if (result.exitCode !== 0 || firstTrimmedLine(result.stdout) !== "f") {
      return yield* context.failure(
        "Cannot prove safe PostgreSQL administrator adoption. Inspect the lando_admin role and host authentication rules.",
      );
    }
    return sqlRequest(context, candidate, {
      sql: "BEGIN; CREATE ROLE lando_admin LOGIN SUPERUSER PASSWORD NULL; COMMENT ON ROLE lando_admin IS 'lando:db-admin:v1'; COMMIT;",
    });
  });
  const listSiblings = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      sqlRequest(context, candidate, {
        sql: "SELECT datname FROM pg_database WHERE NOT datistemplate AND datname <> 'postgres' ORDER BY datname LIMIT 17",
      }),
    );
    if (result.exitCode !== 0)
      return yield* context.failure("Could not read the PostgreSQL database inventory.");
    return result.stdout.trim().split("\n").filter(Boolean);
  });
  return { admin, delta, listSiblings, managed: { prove, adoption } };
};
