<?php
setlocale(LC_ALL, '');
$date = new IntlDateFormatter(null, IntlDateFormatter::FULL, IntlDateFormatter::NONE, 'UTC');
echo setlocale(LC_ALL, 0), PHP_EOL;
echo $date->format(new DateTime('2025-01-01')), PHP_EOL;
