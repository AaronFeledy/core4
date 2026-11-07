package main

import (
	"errors"
	"net"
	"os"
	"syscall"
)

// EX_UNAVAILABLE distinguishes an unreachable proxy from missing client setup (127).
const proxyUnreachableExitCode = 69

type proxyConnectionError struct {
	reason string
}

func (e *proxyConnectionError) Error() string {
	return "Cannot reach the Lando host proxy: " + e.reason + ".\nRun `lando start` for this app on the host, then retry."
}

func proxyConnectFailure(err error) error {
	var operation *net.OpError
	if !errors.As(err, &operation) || operation.Op != "dial" {
		return err
	}
	reason := "connection failed"
	switch {
	case errors.Is(err, os.ErrPermission):
		reason = "permission denied"
	case errors.Is(err, os.ErrNotExist):
		reason = "socket not found"
	case errors.Is(err, syscall.ECONNREFUSED):
		reason = "connection refused"
	case operation.Timeout():
		reason = "connection timed out"
	}
	return &proxyConnectionError{reason: reason}
}
