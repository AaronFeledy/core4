import { type HealthcheckPlan, PortNumber } from "@lando/sdk/schema";
import { commandHealthcheck } from "./_feature-helpers.ts";

// Dial the declared target with bash /dev/tcp (bounded by `timeout` when present) or nc,
// then run any trailing argv only after the listener accepted a connection.
const TCP_PROBE_SCRIPT = `if command -v bash >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 2 bash -c 'exec 3<>"/dev/tcp/$LANDO_PROBE_HOST/$LANDO_PROBE_PORT"' 2>/dev/null
  else
    bash -c 'exec 3<>"/dev/tcp/$LANDO_PROBE_HOST/$LANDO_PROBE_PORT"' 2>/dev/null
  fi
elif command -v nc >/dev/null 2>&1; then
  nc -z -w 2 "$LANDO_PROBE_HOST" "$LANDO_PROBE_PORT" 2>/dev/null
else
  echo "Lando's TCP probe needs bash or nc in this image" >&2
  exit 1
fi || {
  printf "Lando's TCP probe could not connect to %s:%s\\n" "$LANDO_PROBE_HOST" "$LANDO_PROBE_PORT" >&2
  exit 1
}
[ "$#" -eq 0 ] || exec "$@"`;

type ProbeTiming = Partial<Pick<HealthcheckPlan, "intervalSeconds" | "timeoutSeconds" | "retries">>;

export const tcpProbe = (
  port: number,
  startPeriodSeconds: number,
  timing: ProbeTiming = {},
): HealthcheckPlan & { readonly command: readonly string[] } => {
  const command = ["sh", "-c", TCP_PROBE_SCRIPT, "lando-probe"];
  return {
    ...commandHealthcheck(command, startPeriodSeconds, timing),
    command,
    target: { port: PortNumber.make(port), transport: "tcp", names: [], primary: false },
  };
};

export const tcpThenProbe = (
  port: number,
  argv: readonly string[],
  startPeriodSeconds: number,
): HealthcheckPlan => {
  const probe = tcpProbe(port, startPeriodSeconds);
  return { ...probe, command: ["sh", "-c", TCP_PROBE_SCRIPT, "lando-probe", ...argv] };
};
