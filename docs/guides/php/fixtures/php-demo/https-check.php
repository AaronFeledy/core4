<?php
header('Content-Type: application/json');
echo json_encode([
    'https' => $_SERVER['HTTPS'] ?? '',
    'scheme' => $_SERVER['REQUEST_SCHEME'] ?? '',
    'port' => (string) ($_SERVER['SERVER_PORT'] ?? ''),
]);
