#!/usr/bin/env bash
set -u
L=/home/aaron/projects/experiments/lando4-wt-global-config/core/dist/lando
W=$(mktemp -d /tmp/lv-XXXX); export LANDO_USER_CONF_ROOT=$W/conf; mkdir -p $W/conf/config.d $W/app
printf 'name: lvrepair\nservices:\n  q:\n    type: compose\n    image: alpine:3.20\n    home: false\n    command: ["sleep", "infinity"]\n' > $W/app/.lando.yml
cd $W/app
run() { echo "### \$ ${*: -3}"; timeout 600 "$@" 2>&1 | tail -n 12; echo "### exit ${PIPESTATUS[0]}"; }
echo "host=$(hostname)"
printf '# my comment\nrouter:\n  httpPort: 99999\ndefaultProvidreId: lando\ntracing:\n  otlp:\n    headers: secret-canary-123\n' > $W/conf/config.yml
printf 'router:\n  httpsPort: 70000\n' > $W/conf/config.d/10-team.yml
run $L info
run $L config unset router.httpPort
run $L config unset tracing
run $L config unset defaultProvidreId
run $L config set router.httpPort 99999
run $L config validate
echo "### config.yml:"; cat $W/conf/config.yml | grep -v canary
printf 'router: {}\n' > $W/conf/config.d/10-team.yml
run $L config set router.httpPort 8090
run $L start
run $L exec q -- echo live-ok
run $L destroy -y --volumes
rm -rf $W; echo "### DONE"
