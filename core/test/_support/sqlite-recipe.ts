import { expect } from "bun:test";
import { type AppPlan, ServiceName } from "@lando/sdk/schema";

export const expectSqliteRecipePlan = (plan: AppPlan, recipeId: string): void => {
  const service = plan.services[ServiceName.make(recipeId === "laravel" ? "appserver" : "web")];
  const path = {
    laravel: "database/database.sqlite",
    django: "db.sqlite3",
    rails: "storage/development.sqlite3",
  }[recipeId];
  if (path === undefined) throw new TypeError(`Missing SQLite expectation for ${recipeId}`);
  expect(service?.sqlite).toEqual({ path });
  expect(plan.services[ServiceName.make("database")]).toBeUndefined();
  const environment =
    recipeId === "laravel"
      ? { DB_CONNECTION: "sqlite" }
      : recipeId === "django"
        ? { DATABASE_URL: "sqlite:////app/db.sqlite3" }
        : { RAILS_ENV: "development" };
  expect(service?.environment).toMatchObject(environment);
  if (recipeId === "laravel") {
    for (const planned of [service, plan.services[ServiceName.make("worker")]]) {
      if (planned === undefined) continue;
      expect(
        Object.fromEntries(Object.entries(planned.environment).filter(([key]) => key.startsWith("DB_"))),
      ).toEqual({ DB_CONNECTION: "sqlite" });
    }
  }
  if (recipeId === "rails") expect(service?.environment.DATABASE_URL).toBeUndefined();
  const worker = plan.services[ServiceName.make("worker")];
  if (worker !== undefined) expect(worker.environment).toMatchObject(environment);
  for (const planned of Object.values(plan.services)) {
    expect(planned.dependsOn?.map(({ service }) => service)).not.toContain("database");
  }
};
