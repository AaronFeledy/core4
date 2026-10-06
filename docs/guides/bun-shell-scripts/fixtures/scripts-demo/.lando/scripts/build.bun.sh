# ---
# desc: Build dist/ from src/ on the host
# ---
rm -rf dist
mkdir -p dist
cp src/index.html dist/index.html
echo "built dist/ from src/"
