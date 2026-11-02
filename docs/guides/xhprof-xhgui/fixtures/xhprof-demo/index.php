<?php
function fib(int $n): int
{
    return $n < 2 ? $n : fib($n - 1) + fib($n - 2);
}

echo 'fib(25) = ' . fib(25) . "\n";
