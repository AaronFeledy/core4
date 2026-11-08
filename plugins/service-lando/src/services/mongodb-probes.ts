import type { HealthcheckPlan } from "@lando/sdk/schema";
import { tcpProbe, tcpThenProbe } from "./_tcp-probe.ts";

export const mongodbProbes = (
  port: number,
): { readonly healthcheck: HealthcheckPlan; readonly readiness: HealthcheckPlan } => {
  return {
    healthcheck: tcpProbe(port, 30),
    readiness: tcpThenProbe(
      port,
      [
        "bash",
        "-ec",
        [
          "umask 077",
          "probe_home=$(mktemp -d /tmp/lando-mongo-probe.XXXXXXXX)",
          "trap 'rm -rf -- \"$probe_home\"' EXIT",
          "host=$LANDO_PROBE_HOST",
          'case "$host" in *:*) host="[$host]" ;; esac',
          'HOME="$probe_home" mongosh --quiet --norc "mongodb://$host:$LANDO_PROBE_PORT/admin?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&socketTimeoutMS=2000" --eval "quit(db.adminCommand({ping: 1}).ok === 1 ? 0 : 1)"',
        ].join("\n"),
      ],
      30,
    ),
  };
};
