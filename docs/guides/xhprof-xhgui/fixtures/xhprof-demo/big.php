<?php
ini_set('memory_limit', '1G');
$n = (int) ($_GET['n'] ?? 20000);
for ($i = 0; $i < $n; $i++) {
    eval("function profile_padding_function_$i() { return $i; }");
    ("profile_padding_function_$i")();
}
echo "called $n functions\n";
