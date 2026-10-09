# ---
# desc: Write a version stamp into dist/
# ---
echo "$1" > dist/version.txt
echo "stamped dist/version.txt with $1"
