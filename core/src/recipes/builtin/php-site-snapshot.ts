import type { ExpressionNode } from "@lando/sdk/expressions";
import { arr, call, defaultRoute, lit, obj } from "./snapshot-expression.ts";

/** Drupal upload tree. Authored only by the Drupal and Drupal CMS recipes. */
export const DRUPAL_NGINX_NO_SCRIPTS = ["sites/*/files"] as const;

export const phpSiteSnapshotBuilders = ({
  framework,
  databaseFields = [],
  appserverMounts,
  appserverBuild,
  edgeFields = [],
}: {
  readonly framework: string;
  readonly databaseFields?: ReadonlyArray<readonly [string, ExpressionNode]>;
  readonly appserverMounts?: () => ExpressionNode;
  readonly appserverBuild?: () => ExpressionNode;
  readonly edgeFields?: ReadonlyArray<readonly [string, ExpressionNode]>;
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
      ...edgeFields.map(([key, value]) => [key, structuredClone(value)] as const),
      ["routes", primaryRoutes()],
    ]);
  return { usesNginx, primaryRoutes, databaseService, apacheAppserver, fpmAppserver, edgeService };
};
