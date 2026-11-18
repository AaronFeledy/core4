// Loaded before Adminer defines SERVER and DB. Use the configured target to
// establish the session, then let Adminer own connection and action handling.
export const adminerPlugin = String.raw`<?php
namespace Adminer;

// index.php resolves adminer.php and plugins-enabled/ relative to the document
// root, so pin it before any entry point (or an authored working directory) runs.
chdir(dirname(__DIR__));
// PHP's server also exposes adminer.php directly. Only the image's index
// loads configured plugins, so refuse other PHP entry points before dispatch.
if (!class_exists(Plugin::class, false)) {
    if ($_SERVER['SCRIPT_FILENAME'] !== '/var/www/html/index.php') {
        http_response_code(404);
        exit;
    }
    return;
}

return new class extends Plugin {
    private const SESSION_MARKER = 'lando-managed-target';
    private array $targets;
    private ?array $target = null;

    public function __construct() {
        $this->targets = json_decode(getenv('LANDO_ADMINER_SERVERS') ?: '{}', true, 512, JSON_THROW_ON_ERROR);

        if (isset($_POST['lando_target'])) {
            $name = $_POST['lando_target'];
            $target = is_string($name) ? ($this->targets[$name] ?? null) : null;
            if (!$target || isset($_POST['auth']) || !isset($_POST['token']) || !isset($_SESSION['token']) || !verify_token()) {
                $this->refuse();
            }
            session_regenerate_id();
            $server = $this->query($name, $target)[$target['driver']];
            $_SESSION['pwds'][$target['driver']][$server][$target['user']] = self::SESSION_MARKER;
            redirect('?' . http_build_query($this->query($name, $target)));
        }
        if (isset($_POST['auth'])) {
            $this->refuse();
        }

        $single = count($this->targets) === 1;
        if ($single && !isset($_GET['username']) && !isset($_GET['manifest']) && $_SERVER['REQUEST_METHOD'] === 'GET') {
            $name = array_key_first($this->targets);
            $target = $this->targets[$name];
            $query = $this->query($name, $target);
            foreach (['server', 'pgsql', 'sqlite', 'mssql', 'oracle'] as $driver) {
                if (isset($_GET[$driver]) && (!isset($query[$driver]) || $_GET[$driver] !== $query[$driver])) {
                    $this->refuse();
                }
            }
            redirect('?' . http_build_query($query + $_GET));
        }

        if (!isset($_GET['username'])) {
            return;
        }
        $driver = defined(__NAMESPACE__ . '\DRIVER') ? DRIVER : 'server';
        $server = $_GET[$driver] ?? '';
        foreach ($this->targets as $name => $target) {
            $query = $this->query($name, $target);
            if ($driver !== $target['driver'] || $server !== $query[$driver] || $_GET['username'] !== $target['user']) {
                continue;
            }
            if ($driver === 'sqlite' && (($_GET['db'] ?? '') !== $target['database']
                || isset($_GET['create']) || isset($_GET['database']) || isset($_POST['db']))) {
                $this->refuse();
            }
            $this->target = $target;
            if ($_SERVER['REQUEST_METHOD'] === 'GET') {
                $_SESSION['token'] ??= random_int(1, 1000000);
                $_SESSION['pwds'][$driver][$server][$target['user']] = self::SESSION_MARKER;
            }
            return;
        }
        $this->refuse();
    }

    private function query(string $name, array $target): array {
        return [
            $target['driver'] => ($target['driver'] === 'sqlite' && count($this->targets) === 1 ? '' : $name),
            'username' => $target['user'],
            'db' => $target['database'],
        ];
    }

    private function refuse(): never {
        http_response_code(403);
        exit('Choose a database declared in this Lando app.');
    }

    public function credentials(): array {
        if (!$this->target || get_password() !== self::SESSION_MARKER) {
            $this->refuse();
        }
        return [$this->target['host'], $this->target['user'], (string) getenv($this->target['passwordEnv'])];
    }

    public function login(string $login, string $password): bool {
        // The network driver has already authenticated. SQLite has no password
        // to check; only the exact declared file can reach this hook.
        return $this->target !== null && $password === self::SESSION_MARKER;
    }

    public function databases(bool $flush = true): ?array {
        return $this->target && $this->target['driver'] === 'sqlite' ? [$this->target['database']] : null;
    }

    public function loginForm(): bool {
        $options = [];
        foreach ($this->targets as $key => $target) {
            $options[$key] = $target['label'];
        }
        echo '<p><label>' . lang('Server') . ' ' . html_select('lando_target', $options, SERVER) . '</label></p>';
        echo '<p><input type="submit" value="' . h(lang('Login')) . '"></p>';
        return true;
    }
};
`;
