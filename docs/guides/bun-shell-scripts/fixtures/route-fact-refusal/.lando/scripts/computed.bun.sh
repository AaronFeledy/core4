# ---
# desc: Read a route fact through a computed service name
# env:
#   SITE_URL: "{{ services[vars.name].url }}"
# ---
echo "$SITE_URL"
