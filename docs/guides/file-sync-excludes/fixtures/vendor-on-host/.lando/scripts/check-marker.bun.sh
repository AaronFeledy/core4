# ---
# desc: Report whether the service's node_modules marker reached the host
# ---
test ! -e node_modules/marker.txt && echo absent
