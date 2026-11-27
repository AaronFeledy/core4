package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type helperIO struct {
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
	env    map[string]string
}

func main() {
	env := make(map[string]string)
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok {
			env[name] = value
		}
	}
	os.Exit(dispatch(os.Args[0], os.Args[1:], helperIO{os.Stdin, os.Stdout, os.Stderr, env}))
}

func dispatch(argv0 string, args []string, streams helperIO) int {
	switch filepath.Base(argv0) {
	case "lando":
		return runHostProxy(context.Background(), args, streams)
	case "xdg-open", "open":
		return runHostOpen(context.Background(), args, streams)
	case "lando-create-project":
		return runCreateProject(args, streams, nil)
	case "lando-drupal-scaffold":
		return runDrupalScaffold(args, streams, nil)
	case "lando-drupal-cms-scaffold":
		return runDrupalCmsScaffold(args, streams, nil)
	case "lando-" + drupalContribSyncCommand:
		return runDrupalContribSync(args, streams, nil)
	}
	if len(args) > 0 {
		switch args[0] {
		case "exec-run":
			return runExecRun(args[1:], streams)
		case "exec-signal":
			return runExecSignal(argv0, args[1:])
		case "log-file":
			if err := runLogFile(streams.stdin, streams.stdout); err != nil {
				fmt.Fprintln(streams.stderr, err)
				return 1
			}
			return 0
		case "probe-http":
			return runProbeHTTP(args[1:], streams)
		case "probe-tcp":
			return runProbeTCP(args[1:], streams)
		}
	}
	fmt.Fprintln(streams.stderr, "Usage: lando [args...] (host-proxy client) | lando-container-helper exec-run -- <argv> | lando-container-helper log-file | lando-container-helper probe-http --url <url> --timeout <seconds> | lando-container-helper probe-tcp --host <host> --port <port> --timeout <seconds> | lando-create-project <package> [<version>] [--no-scripts] | "+drupalScaffoldUsage+" | "+drupalCmsScaffoldUsage+" | lando-drupal-contrib-sync <type> <project> <constraint>")
	return 64
}
