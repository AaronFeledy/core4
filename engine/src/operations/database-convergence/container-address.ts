// These catalog images all ship getent. Resolving the runtime's hostname avoids depending on the
// optional hostname binary or choosing a peer's address from /etc/hosts.
export const containerAddress = String.raw`
container_address() {
  getent ahostsv4 "$(cat /etc/hostname)" | while read -r candidate _; do
    case "$candidate" in
      127.*|0.*|*[!0-9.]*|*.*.*.*.*) ;;
      *.*.*.*) printf '%s\n' "$candidate"; break ;;
    esac
  done
}
`;
