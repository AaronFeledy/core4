# ---
# desc: Inspect release inputs
# flags:
#   loud:
#     boolean: true
#     default: true
# args:
#   label:
#     order: 0
#   channel:
#     order: 1
#     default: stable
#     choices: [stable, beta]
# ---
printf '%s\n' "$LANDO_INPUT"
