# ---
# desc: Create .env from .env.example if it is missing
# ---
if test -f .env; then
  echo ".env already exists, leaving it alone"
else
  cp .env.example .env
  echo "created .env"
fi
