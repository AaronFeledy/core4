import { AppId, type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";
import type { SqlCommandDeps } from "./command-types.ts";

export const providerSqlExec =
  (provider: Pick<RuntimeProvider["Service"], "exec">, applied: AppPlan): SqlCommandDeps["exec"] =>
  (service, command, env) =>
    provider
      .exec(
        { app: AppId.make(applied.id), service: ServiceName.make(service), plan: applied },
        { command, ...(env === undefined ? {} : { env }) },
      )
      .pipe(Effect.map((result) => ({ ok: result.exitCode === 0, stdout: result.stdout })));
