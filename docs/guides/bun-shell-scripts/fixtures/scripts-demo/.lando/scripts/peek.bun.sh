# ---
# desc: Start the app and print the stamp web serves
# ---
lando start
lando exec web -- cat /app/dist/version.txt
