# ---
# desc: Demonstrate protected input
# flags:
#   note:
#     sensitive: true
#     required: true
# args:
#   target:
#     required: true
#     choices: [dev, prod]
# ---
echo ran > body-marker.txt
printf '%s\n' "$LANDO_FLAG_NOTE"
