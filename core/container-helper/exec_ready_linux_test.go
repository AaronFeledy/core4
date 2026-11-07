package main

import (
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExecReadyWaitsForSupervisorSocket(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	result := make(chan execReply, 1)
	go func() {
		result <- execControlExchangeTimeout(dir, execRequest{Op: "ready"}, time.Second)
	}()
	select {
	case reply := <-result:
		t.Fatalf("readiness returned before the supervisor listened: %+v", reply)
	case <-time.After(50 * time.Millisecond):
	}
	listener, err := net.Listen("unix", filepath.Join(dir, "control"))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		var request execRequest
		if json.NewDecoder(conn).Decode(&request) == nil {
			json.NewEncoder(conn).Encode(execReply{OK: true, State: "ready"})
		}
	}()
	select {
	case reply := <-result:
		if !reply.OK || reply.State != "ready" {
			t.Fatalf("readiness failed: %+v", reply)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("readiness did not complete after the supervisor listened")
	}
}

func TestExecReadyWaitHasBoundedDeadline(t *testing.T) {
	dir := t.TempDir()
	if err := os.Chmod(dir, 0700); err != nil {
		t.Fatal(err)
	}
	reply := execControlExchangeTimeout(dir, execRequest{Op: "ready"}, 50*time.Millisecond)
	if reply.OK || reply.Error != "control-unavailable" {
		t.Fatalf("missing supervisor accepted: %+v", reply)
	}
}
