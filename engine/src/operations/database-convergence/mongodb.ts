import { Effect } from "effect";
import { classifyAdminFailure, firstTrimmedLine, step } from "./client.ts";
import { mongoAdminProof } from "./mongodb-admin-proof.ts";
import type {
  AdapterContext,
  AdminCredential,
  ClientRequest,
  ClientResult,
  CredentialAdapter,
  CredentialStep,
} from "./types.ts";

const SYSTEM_DATABASES = new Set(["admin", "config", "local"]);
const NAME_MAX = 63;
const AUTH_SOURCE = "admin";
const CONNECT_SUFFIX =
  "directConnection=true&serverSelectionTimeoutMS=3000&connectTimeoutMS=3000&socketTimeoutMS=3000";

const isSafeName = (value: string): boolean =>
  value.length > 0 &&
  value.length <= NAME_MAX &&
  !/[\p{Cc}\p{Cs}]/u.test(value) &&
  !value.includes("\x00") &&
  new TextEncoder().encode(value).length <= NAME_MAX;

const mongoUri = (options: {
  readonly user: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
}): string =>
  `mongodb://${encodeURIComponent(options.user)}:${encodeURIComponent(options.password)}@${options.host}:${options.port}/${encodeURIComponent(options.database)}?authSource=${AUTH_SOURCE}&${CONNECT_SUFFIX}`;

/**
 * Constant eval scripts read secrets only from process.env. Disposable HOME keeps mongosh off the data volume.
 */
const mongoshRequest = (options: {
  readonly uri: string;
  readonly eval: string;
  readonly env?: Readonly<Record<string, string>>;
}): ClientRequest => ({
  argv: [
    "bash",
    "-ec",
    [
      "umask 077",
      "probe_home=$(mktemp -d /tmp/lando-db-creds.XXXXXXXX)",
      "trap 'rm -rf -- \"$probe_home\"' EXIT",
      'HOME="$probe_home" mongosh --nodb --norc --quiet --eval "$LANDO_MONGO_EVAL"',
    ].join("\n"),
  ],
  env: {
    MONGO_URI: options.uri,
    LANDO_MONGO_EVAL: options.eval,
    ...(options.env ?? {}),
  },
});

const ADMIN_PROOF_EVAL =
  'db=connect(process.env.MONGO_URI); const st=db.adminCommand({connectionStatus:1}); const roles=(st.authInfo&&st.authInfo.authenticatedUserRoles)||[]; print(roles.some((r)=>r.role==="root"&&r.db==="admin")?"1":"0")';

const USER_INFO_EVAL =
  'db=connect(process.env.MONGO_URI); const user=process.env.MONGO_TARGET_USER; const info=db.getSiblingDB("admin").runCommand({usersInfo:{user,db:"admin"}}); if (info.ok===1 && Array.isArray(info.users)) { if (info.users.length===0) print("0"); else if (info.users.length===1 && info.users[0]?.user===user && info.users[0]?.db==="admin") print("1"); }';

const CREATE_USER_EVAL =
  'db=connect(process.env.MONGO_URI); db.getSiblingDB("admin").createUser({user:process.env.MONGO_TARGET_USER,pwd:process.env.MONGO_TARGET_PASSWORD,roles:[{role:"root",db:"admin"}]})';

const CHANGE_PASSWORD_EVAL =
  'db=connect(process.env.MONGO_URI); db.getSiblingDB("admin").changeUserPassword(process.env.MONGO_TARGET_USER, process.env.MONGO_TARGET_PASSWORD)';

const PING_EVAL = "db=connect(process.env.MONGO_URI); db.runCommand({ping:1})";

const privilegeDenied = (result: ClientResult): boolean =>
  /not authorized/iu.test(result.stderr) ||
  /requires authentication/iu.test(result.stderr) ||
  /Unauthorized/iu.test(result.stderr);

export const mongodb = (context: AdapterContext): CredentialAdapter => {
  if (context.family !== "mongodb") {
    return {
      admin: () => Effect.fail(context.failure("mongodb adapter only serves mongodb.")),
      delta: () => Effect.fail(context.failure("mongodb adapter only serves mongodb.")),
    };
  }

  const adminUri = (candidate: AdminCredential): string =>
    mongoUri({
      user: candidate.user,
      password: candidate.password,
      host: "127.0.0.1",
      port: context.port,
      database: AUTH_SOURCE,
    });

  const admin = Effect.fnUntraced(function* (
    candidate: AdminCredential,
  ): Effect.fn.Return<
    "accepted" | "rejected" | "insufficient-privilege",
    ReturnType<AdapterContext["failure"]>
  > {
    if (!isSafeName(candidate.user)) return "rejected";
    const result = yield* context.run(
      mongoshRequest({
        uri: adminUri(candidate),
        eval: ADMIN_PROOF_EVAL,
      }),
    );
    if (result.exitCode !== 0 || result.state !== "accepted") {
      return yield* classifyAdminFailure(context, result, privilegeDenied);
    }
    const proof = firstTrimmedLine(result.stdout);
    if (proof === "1") return "accepted";
    if (proof === "0") return "insufficient-privilege";
    return yield* Effect.fail(
      context.failure("Could not read root role proof for the connected MongoDB user.", result.exitCode),
    );
  });

  const delta = Effect.fnUntraced(function* (
    adminCredential: AdminCredential,
  ): Effect.fn.Return<readonly CredentialStep[], ReturnType<AdapterContext["failure"]>> {
    const { desired } = context;
    if (!isSafeName(desired.user) || !isSafeName(desired.database)) {
      return yield* Effect.fail(
        context.failure("The desired database or login name cannot be represented safely."),
      );
    }
    if (SYSTEM_DATABASES.has(desired.database)) {
      return yield* Effect.fail(
        context.failure(`Refusing to target the reserved MongoDB database ${desired.database}.`),
      );
    }

    // Positive catalog evidence only (usersInfo). Never treat classifier database-missing as absence.
    const inventory = yield* context.run(
      mongoshRequest({
        uri: adminUri(adminCredential),
        eval: USER_INFO_EVAL,
        env: { MONGO_TARGET_USER: desired.user },
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
          context.failure("Administrator lacks privilege to inspect users.", inventory.exitCode),
        );
      }
      return yield* Effect.fail(
        context.failure("Could not inspect the MongoDB user catalog.", inventory.exitCode),
      );
    }
    const presence = inventory.stdout.trim();
    if (presence !== "0" && presence !== "1") {
      return yield* Effect.fail(
        context.failure("Could not read a present/absent usersInfo result for the desired MongoDB user."),
      );
    }
    const userExists = presence === "1";
    const steps: CredentialStep[] = [];

    if (!userExists) {
      steps.push(
        step(
          ["user", "password"],
          mongoshRequest({
            uri: adminUri(adminCredential),
            eval: CREATE_USER_EVAL,
            env: {
              MONGO_TARGET_USER: desired.user,
              MONGO_TARGET_PASSWORD: desired.password,
            },
          }),
        ),
      );
    } else {
      const login = yield* context.run(
        mongoshRequest({
          uri: mongoUri({
            user: desired.user,
            password: desired.password,
            host: "127.0.0.1",
            port: context.port,
            database: AUTH_SOURCE,
          }),
          eval: PING_EVAL,
        }),
      );
      if (login.state === "rejected") {
        steps.push(
          step(
            ["password"],
            mongoshRequest({
              uri: adminUri(adminCredential),
              eval: CHANGE_PASSWORD_EVAL,
              env: {
                MONGO_TARGET_USER: desired.user,
                MONGO_TARGET_PASSWORD: desired.password,
              },
            }),
          ),
        );
      } else if (login.state !== "accepted" || login.exitCode !== 0) {
        return yield* Effect.fail(
          context.failure(
            "Could not prove the desired application password against MongoDB.",
            login.exitCode,
          ),
        );
      }
    }

    // Database-name-only drift is a logical no-op: Mongo materializes namespaces on first write.
    return steps;
  });

  const managedRequest = (candidate: AdminCredential, evaluate: string, password?: string) =>
    mongoshRequest({
      uri: adminUri(candidate),
      eval: evaluate,
      ...(password === undefined ? {} : { env: { LANDO_MANAGED_PASSWORD: password } }),
    });
  const prove = Effect.fnUntraced(function* (candidate: AdminCredential) {
    const result = yield* context.run(
      managedRequest(
        candidate,
        `const admin = connect(process.env.MONGO_URI); ${mongoAdminProof} print(adminVerified ? "1" : "0");`,
      ),
    );
    return result.exitCode === 0 && firstTrimmedLine(result.stdout) === "1";
  });
  const adoption = Effect.fnUntraced(function* (candidate: AdminCredential, managed: AdminCredential) {
    const result = yield* context.run(
      managedRequest(
        candidate,
        'const db=connect(process.env.MONGO_URI); const info=db.runCommand({usersInfo:{user:"lando_admin",db:"admin"}}); if(info.ok===1 && Array.isArray(info.users)) print(info.users.length)',
      ),
    );
    if (result.exitCode !== 0 || firstTrimmedLine(result.stdout) !== "0") {
      return yield* context.failure(
        "Cannot prove the reserved MongoDB administrator is absent. Inspect lando_admin or restore the Lando seed.",
      );
    }
    return managedRequest(
      candidate,
      'const db=connect(process.env.MONGO_URI); db.createUser({user:"lando_admin",pwd:process.env.LANDO_MANAGED_PASSWORD,roles:[{role:"root",db:"admin"}],authenticationRestrictions:[{clientSource:["127.0.0.1"],serverAddress:["127.0.0.1"]}],customData:{lando:"db-admin:v1"}})',
      managed.password,
    );
  });
  return { admin, delta, managed: { prove, adoption } };
};
