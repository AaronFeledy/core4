# ---
# description: Greet a target environment
# flags:
#   name:
#     alias: n
#     default: world
#   loud:
#     boolean: true
#     default: false
# args:
#   target:
#     order: 0
#     required: true
#     choices: [dev, prod]
#   label:
#     order: 1
#     default: latest
# ---
echo ran > body-marker.txt
printf '%s\n' "$LANDO_INPUT" > last-input.json
printf 'Hello %s: target=%s label=%s loud=%s\n' "$LANDO_FLAG_NAME" "$LANDO_ARG_TARGET" "$LANDO_ARG_LABEL" "$LANDO_FLAG_LOUD"
