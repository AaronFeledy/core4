import type { ExpressionNode } from "@lando/sdk/expressions";
import { arr, call, defaultRoute, lit, obj } from "./snapshot-expression.ts";

export const phpSiteSnapshotBuilders = ({
  framework,
  databaseFields = [],
  appserverMounts,
  appserverBuild,
}: {
  readonly framework: string;
  readonly databaseFields?: ReadonlyArray<readonly [string, ExpressionNode]>;
  readonly appserverMounts?: () => ExpressionNode;
  readonly appserverBuild?: () => ExpressionNode;
}) => {
  const usesNginx = (): ExpressionNode =>
    call(
      "eq",
      { kind: "Path", head: "options", segments: [{ type: "prop", name: "webserver" }] },
      lit("nginx"),
    );
  const primaryRoutes = (): ExpressionNode => arr(defaultRoute());
  const databaseService = (): ExpressionNode =>
    obj([
      ["type", lit("{{ recipe.database }}")],
      ...databaseFields.map(([key, value]) => [key, structuredClone(value)] as const),
    ]);
  const apacheAppserver = (): ExpressionNode =>
    obj([
      ["type", lit("php:{{ recipe.php }}")],
      ["primary", lit(true)],
      ["framework", lit(framework)],
      ["webroot", lit("{{ recipe.webroot }}")],
      ["composer", lit("{{ recipe.composer }}")],
      ["allowOverride", lit(true)],
      ["port", lit(80)],
      ["dependsOn", arr(lit("database"))],
      ...(appserverMounts === undefined ? [] : [["mounts", appserverMounts()] as const]),
      ...(appserverBuild === undefined ? [] : [["build", appserverBuild()] as const]),
      ["routes", primaryRoutes()],
    ]);
  const fpmAppserver = (): ExpressionNode =>
    obj([
      ["type", lit("php:{{ recipe.php }}")],
      ["primary", lit(true)],
      ["framework", lit(framework)],
      ["via", lit("fpm")],
      ["webroot", lit("{{ recipe.webroot }}")],
      ["composer", lit("{{ recipe.composer }}")],
      ["dependsOn", arr(lit("database"))],
      ...(appserverMounts === undefined ? [] : [["mounts", appserverMounts()] as const]),
      ...(appserverBuild === undefined ? [] : [["build", appserverBuild()] as const]),
    ]);
  const edgeService = (): ExpressionNode =>
    obj([
      ["type", lit("nginx")],
      ["backend", lit("appserver")],
      ["webroot", lit("{{ recipe.webroot }}")],
      ["routes", primaryRoutes()],
    ]);
  return { usesNginx, primaryRoutes, databaseService, apacheAppserver, fpmAppserver, edgeService };
};
