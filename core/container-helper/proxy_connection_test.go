package main

import (
	"bytes"
	"errors"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestProxyConnectFailure(t *testing.T) {
	for _, tc := range []struct {
		name, network, reason string
		cause                 error
	}{
		{"permission", "unix", "permission denied", syscall.EACCES},
		{"refused socket", "unix", "connection refused", syscall.ECONNREFUSED},
		{"missing socket", "unix", "socket not found", syscall.ENOENT},
		{"refused TCP", "tcp", "connection refused", syscall.ECONNREFUSED},
		{"timeout", "tcp", "connection timed out", os.ErrDeadlineExceeded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Given a wrapped HTTP dial error containing private transport details.
			original := &url.Error{Op: "Post", URL: "http://private-target/runLando", Err: &net.OpError{
				Op: "dial", Net: tc.network, Err: tc.cause,
			}}
			// When classifying the failure.
			failure := proxyConnectFailure(original)
			// Then only the stable reason and recovery action are exposed.
			var connection *proxyConnectionError
			want := "Cannot reach the Lando host proxy: " + tc.reason + ".\nRun `lando start` for this app on the host, then retry."
			if !errors.As(failure, &connection) || failure.Error() != want {
				t.Fatalf("failure=%v", failure)
			}
		})
	}
}

func TestUnreachableProxyAcrossClientRoles(t *testing.T) {
	for _, network := range []string{"missing", "unix", "tcp"} {
		for _, role := range []string{"lando", "xdg-open", "open"} {
			t.Run(network+"/"+role, func(t *testing.T) {
				// Given credentials and a missing or refusing endpoint.
				env := proxyEnv(t)
				socket := filepath.Join(t.TempDir(), "proxy.sock")
				env["LANDO_HOST_PROXY_SOCKET"] = socket
				reason := "socket not found"
				if network != "missing" {
					address := socket
					if network == "tcp" {
						address = "127.0.0.1:0"
					}
					listener, err := net.Listen(network, address)
					if err != nil {
						t.Fatal(err)
					}
					if network == "tcp" {
						env["LANDO_HOST_PROXY_URL"] = "http://" + listener.Addr().String()
					} else if unix, ok := listener.(*net.UnixListener); ok {
						unix.SetUnlinkOnClose(false)
					}
					if err := listener.Close(); err != nil {
						t.Fatal(err)
					}
					reason = "connection refused"
				}
				var out, stderr bytes.Buffer
				args := []string{"https://example.com"}
				if role == "lando" {
					args = []string{"open", "--print"}
				}
				// When invoking the installed client role.
				code := dispatch(role, args, helperIO{stdout: &out, stderr: &stderr, env: env})
				// Then all roles give the same safe diagnostic and unavailable exit status.
				want := "Cannot reach the Lando host proxy: " + reason + ".\nRun `lando start` for this app on the host, then retry.\n"
				if code != 69 || out.Len() != 0 || stderr.String() != want {
					t.Fatalf("code=%d stdout=%q stderr=%q", code, out.String(), stderr.String())
				}
			})
		}
	}
}

func TestProxyConnectFailurePreservesNonDialErrors(t *testing.T) {
	// Given a protocol failure after connecting, rather than an unavailable listener.
	original := &net.OpError{Op: "read", Net: "unix", Err: syscall.ECONNRESET}
	// When classifying it, preserve the existing protocol-error behavior.
	if !errors.Is(proxyConnectFailure(original), original) {
		t.Fatal("non-dial error was reclassified")
	}
}
