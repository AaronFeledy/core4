import { AppId, type AppPlan, ServiceName } from "@lando/sdk/schema";
import type { RuntimeProvider } from "@lando/sdk/services";
import type { SqlCommandDeps } from "./command-types.ts";

export const providerSqlExec =
  (provider: Pick<RuntimeProvider["Service"], "execStream">, applied: AppPlan): SqlCommandDeps["exec"] =>
  (service, command, env) =>
    provider.execStream(
      { app: AppId.make(applied.id), service: ServiceName.make(service), plan: applied },
      { command, ...(env === undefined ? {} : { env }) },
    );
