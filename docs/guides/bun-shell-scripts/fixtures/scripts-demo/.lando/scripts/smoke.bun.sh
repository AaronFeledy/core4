# ---
# description: Fetch a path from the running site and fail loudly
# env:
#   SITE_URL: "{{ services.web.url }}"
# args:
#   path:
#     order: 0
#     required: true
#     description: Path to fetch, such as version.txt
# ---
curl -sf "$SITE_URL/$LANDO_ARG_PATH"
