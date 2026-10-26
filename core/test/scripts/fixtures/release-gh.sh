#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> gh.log
fail() { echo "$1" >&2; exit "$2"; }
scenario=${GH_SCENARIO:-success}

if [ "$*" = 'api --paginate repos/{owner}/{repo}/releases --jq .[].tag_name' ]; then
  [ "$scenario" != list-failure ] || fail 'Release list unavailable' 40
  echo v4.0.0-dev.420
  if [ -d release ]; then echo v4.0.0-dev.42; fi
  exit 0
fi

if [ "$1 $2" = 'release upload' ]; then
  [ "$3" = v4.0.0-dev.42 ] || fail 'Wrong tag' 90
  [ "$(cat release/draft)" = true ] || fail 'Upload targeted a public release' 90
  shift 3
  for asset in "$@"; do
    [ -s "$asset" ] || fail "Missing asset: $asset" 42
    cp "$asset" "release/assets/$(basename "$asset")"
    case "$scenario" in
      partial-upload|cleanup-failure|cleanup-ambiguous|state-failure) fail 'Upload failed after one asset' 42 ;;
      upload-public) echo false > release/draft; fail 'Release was published externally' 42 ;;
    esac
  done
  exit 0
fi

[ "$1" = api ] || fail 'Unexpected gh command' 90
shift
method=GET
if [ "$1" = --method ]; then method=$2; shift 2; fi
endpoint=$1
shift
case "$method $endpoint" in
  'POST repos/{owner}/{repo}/releases')
    [ "$scenario" != create-failure ] || fail 'Create rejected' 41
    [ ! -d release ] || fail 'Preflight missed an existing release' 90
    args=" $* "
    for field in 'tag_name=v4.0.0-dev.42' 'draft=true' 'prerelease=true' 'target_commitish=fixture'; do
      [[ "$args" = *" $field "* ]] || fail "Missing create field: $field" 90
    done
    [ "${*: -2}" = '--jq .id' ] || fail 'Missing release ID projection' 90
    mkdir -p release/assets
    echo true > release/draft
    [ "$scenario" != create-ambiguous ] || fail 'Create response lost' 41
    if [ "$scenario" = invalid-id ]; then echo null; else echo 123; fi
    ;;
  'GET repos/{owner}/{repo}/releases/123')
    [ "$*" = '--jq .draft' ] || fail 'Unexpected release query' 90
    [ "$scenario" != state-failure ] || fail 'State unavailable' 45
    cat release/draft
    ;;
  'DELETE repos/{owner}/{repo}/releases/123')
    [ "$#" = 0 ] || fail 'Unexpected delete arguments' 90
    [ "$(cat release/draft)" = true ] || fail 'Attempt to delete a public release' 90
    [ "$scenario" != cleanup-failure ] || fail 'Cleanup rejected' 44
    rm -r release
    [ "$scenario" != cleanup-ambiguous ] || fail 'Deleted, but response lost' 44
    ;;
  'PATCH repos/{owner}/{repo}/releases/123')
    [ "$*" = '-F draft=false' ] || fail 'Unexpected publication fields' 90
    [ "$(cat release/draft)" = true ] || fail 'Already public' 90
    find release/assets -type f -exec basename {} \; | sort > actual-assets
    cmp expected-assets actual-assets || fail 'Publication before all assets uploaded' 90
    (cd release/assets && sha256sum -c SHA256SUMS) >&2 || fail 'Incomplete checksums' 90
    [ "$scenario" != publish-failure ] || fail 'Publication rejected' 43
    echo false > release/draft
    [ "$scenario" != publish-ambiguous ] || fail 'Published, but response lost' 43
    ;;
  *) fail "Unexpected API call: $method $endpoint" 90 ;;
esac
