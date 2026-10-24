import type { HealthcheckPlan } from "@lando/sdk/schema";
import { PortNumber } from "@lando/sdk/schema";
import { commandHealthcheck } from "./_feature-helpers.ts";

const dial =
  'if ! (exec 3<>"/dev/tcp/$LANDO_PROBE_HOST/$LANDO_PROBE_PORT") 2>/dev/null; then echo "Mongo listener unavailable" >&2; exit 1; fi';

export const mongodbProbes = (
  port: number,
): { readonly healthcheck: HealthcheckPlan; readonly readiness: HealthcheckPlan } => {
  const target = { port: PortNumber.make(port), transport: "tcp" as const, names: [], primary: false };
  return {
    healthcheck: { ...commandHealthcheck(["bash", "-ec", dial], 30), target },
    readiness: {
      ...commandHealthcheck(
        [
          "bash",
          "-ec",
          [
            dial,
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
      target,
    },
  };
};
