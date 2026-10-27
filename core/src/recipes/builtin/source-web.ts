import type { RecipeConfigLayer, RecipeSourceOption } from "@lando/sdk/schema";

export const defaultRoutes = [
  { hostname: "{{ app.name }}.{{ proxy.defaultDomain }}", scheme: "both" },
] as const;

export const postgresUrl =
  "postgresql://{{ url.encodeComponent(services.database.creds.user) }}:{{ url.encodeComponent(services.database.creds.password) }}@database:{{ services.database.port }}/{{ url.encodeComponent(services.database.creds.database) }}";

export const nodeOption = {
  type: { kind: "enum", values: ["lts", "22"] },
  default: "lts",
  prompt: { message: "Node version" },
} as const satisfies RecipeSourceOption;

export const redisOption = {
  type: { kind: "boolean" },
  default: false,
  prompt: { message: "Add a Redis cache service?" },
} as const satisfies RecipeSourceOption;

export const nodeWebService = (port: number, environment: Readonly<Record<string, string>>) => ({
  type: "node:{{ recipe.node }}",
  port,
  environment,
  routes: defaultRoutes,
});

export const optionalWebDatabase = {
  when: '{{ ne(options.database, "none") }}',
  config: {
    services: {
      web: { dependsOn: ["database"] },
      database: { type: "{{ recipe.database }}" },
    },
  },
} as const satisfies RecipeConfigLayer;

export const staticWebService = (webroot: string) => ({
  type: "static:nginx",
  primary: false,
  appMount: { target: "/app" },
  webroot,
  routes: defaultRoutes,
});
