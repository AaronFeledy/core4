package main

import (
	"encoding/json"
	"io"
	"net"
	"path/filepath"
	"time"
)

func execControlExchange(dir string, request execRequest) execReply {
	return execControlExchangeTimeout(dir, request, 6*time.Second)
}

func execControlExchangeTimeout(dir string, request execRequest, timeout time.Duration) execReply {
	if execCheckPrivateDirectory(dir) != nil {
		return execFailure("unsafe-session")
	}
	deadline := time.Now().Add(timeout)
	dialTimeout := time.Second
	if timeout < dialTimeout {
		dialTimeout = timeout
	}
	conn, err := net.DialTimeout("unix", filepath.Join(dir, "control"), dialTimeout)
	// Readiness is a barrier: wait for the concurrently starting supervisor.
	for err != nil && request.Op == "ready" && time.Now().Before(deadline) {
		if r, ok := execLoad(dir); ok {
			return r
		}
		time.Sleep(10 * time.Millisecond)
		conn, err = net.DialTimeout("unix", filepath.Join(dir, "control"), dialTimeout)
	}
	if err != nil {
		if r, ok := execLoad(dir); ok {
			return r
		}
		return execFailure("control-unavailable")
	}
	defer conn.Close()
	conn.SetDeadline(deadline)
	if json.NewEncoder(conn).Encode(request) != nil {
		return execFailure("control-write-failed")
	}
	var r execReply
	if json.NewDecoder(io.LimitReader(conn, 4096)).Decode(&r) != nil {
		return execFailure("control-read-failed")
	}
	return r
}
