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
	}
	if len(args) > 0 {
		switch args[0] {
		case "exec-cleanup":
			return runExecCleanup(args[1:], streams)
		case "exec-init":
			return runExecInit(args[1:], streams)
		case "exec-supervisor":
			return runExecSupervisor(args[1:], streams)
		case "exec-control":
			return runExecControl(args[1:], streams)
		case "log-file":
			if err := runLogFile(streams.stdin, streams.stdout); err != nil {
				fmt.Fprintln(streams.stderr, err)
				return 1
			}
			return 0
		case "log-file-cleanup":
			if len(args) == 2 {
				if err := cleanupLogFile(args[1], streams.stdout); err != nil {
					fmt.Fprintln(streams.stderr, err)
					return 1
				}
				return 0
			}
		}
	}
	fmt.Fprintln(streams.stderr, "Usage: lando [args...] (host-proxy client) | lando-container-helper log-file | lando-container-helper log-file-cleanup <dir>")
	return 64
}
