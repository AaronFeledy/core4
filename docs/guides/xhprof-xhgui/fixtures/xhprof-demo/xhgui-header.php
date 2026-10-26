<?php
$autoload = '/app/vendor/perftools/php-profiler/autoload.php';
if (PHP_SAPI === 'cli' || !is_file($autoload)) {
    return;
}
require_once $autoload;

try {
    $profiler = new \Xhgui\Profiler\Profiler([
        'save.handler' => \Xhgui\Profiler\Profiler::SAVER_UPLOAD,
        'save.handler.upload' => ['url' => 'http://xhgui/run/import'],
    ]);
    $profiler->start();
} catch (\Throwable $e) {
    error_log('xhgui: ' . $e->getMessage());
}
