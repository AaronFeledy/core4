import type { ExpressionNode } from "@lando/sdk/expressions";
import { arr, call, cond, defaultRoute, lit, obj } from "./snapshot-expression.ts";

export const nodeWebSnapshotBuilders = ({
  port,
  env,
}: {
  readonly port: number;
  readonly env: ReadonlyArray<readonly [string, string]>;
}) => {
  const databaseEnabled = (): ExpressionNode =>
    call(
      "ne",
      { kind: "Path", head: "options", segments: [{ type: "prop", name: "database" }] },
      lit("none"),
    );
  const webService = (hasDatabase: boolean): ExpressionNode =>
    obj([
      ["type", lit("node:{{ recipe.node }}")],
      ["port", lit(port)],
      ["environment", obj(env.map(([key, value]) => [key, lit(value)]))],
      ["routes", arr(defaultRoute())],
      ...(hasDatabase ? [["dependsOn", arr(lit("database"))] as const] : []),
    ]);
  const web = (): ExpressionNode => cond(databaseEnabled(), webService(true), webService(false));
  return { databaseEnabled, webService, web };
};
