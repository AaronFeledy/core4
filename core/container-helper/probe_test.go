package main

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func probeStreams(env map[string]string) (helperIO, *bytes.Buffer, *bytes.Buffer) {
	var out, errBuf bytes.Buffer
	return helperIO{stdin: strings.NewReader(""), stdout: &out, stderr: &errBuf, env: env}, &out, &errBuf
}

func TestParseProbeHTTPArgs(t *testing.T) {
	t.Parallel()
	_, _, err := parseProbeHTTPArgs(nil)
	if err != errProbeUsageHTTP {
		t.Fatalf("empty args: %v", err)
	}
	_, _, err = parseProbeHTTPArgs([]string{"--url", "http://example.invalid/ready"})
	if err != errProbeUsageHTTP {
		t.Fatalf("missing timeout: %v", err)
	}
	_, _, err = parseProbeHTTPArgs([]string{"--url", "ftp://example.invalid/", "--timeout", "1"})
	if err != errProbeUsageHTTP {
		t.Fatalf("bad scheme: %v", err)
	}
	_, _, err = parseProbeHTTPArgs([]string{"--url", "/relative", "--timeout", "1"})
	if err != errProbeUsageHTTP {
		t.Fatalf("relative url: %v", err)
	}
	_, _, err = parseProbeHTTPArgs([]string{"--timeout", "0", "--url", "http://example.invalid/"})
	if err != errProbeUsageHTTP {
		t.Fatalf("zero timeout: %v", err)
	}
	raw, timeout, err := parseProbeHTTPArgs([]string{"--timeout", "1.5", "--url", "https://svc.internal:8443/health"})
	if err != nil || raw != "https://svc.internal:8443/health" || timeout != 1500*time.Millisecond {
		t.Fatalf("got raw=%q timeout=%v err=%v", raw, timeout, err)
	}
}

func TestParseProbeTCPArgs(t *testing.T) {
	t.Parallel()
	_, _, _, err := parseProbeTCPArgs(nil, nil)
	if err != errProbeUsageTCP {
		t.Fatalf("empty: %v", err)
	}
	_, _, _, err = parseProbeTCPArgs([]string{"--host", "db", "--port", "0", "--timeout", "1"}, nil)
	if err != errProbeUsageTCP {
		t.Fatalf("port 0: %v", err)
	}
	_, _, _, err = parseProbeTCPArgs([]string{"--host", "db", "--port", "65536", "--timeout", "1"}, nil)
	if err != errProbeUsageTCP {
		t.Fatalf("port high: %v", err)
	}
	host, port, timeout, err := parseProbeTCPArgs(
		[]string{"--timeout", "2"},
		map[string]string{"LANDO_PROBE_HOST": "cache", "LANDO_PROBE_PORT": "6379"},
	)
	if err != nil || host != "cache" || port != "6379" || timeout != 2*time.Second {
		t.Fatalf("env fallback host=%q port=%q timeout=%v err=%v", host, port, timeout, err)
	}
	host, port, timeout, err = parseProbeTCPArgs(
		[]string{"--host", "appserver", "--port", "80", "--timeout", "3"},
		map[string]string{"LANDO_PROBE_HOST": "cache", "LANDO_PROBE_PORT": "6379"},
	)
	if err != nil || host != "appserver" || port != "80" || timeout != 3*time.Second {
		t.Fatalf("flags override host=%q port=%q timeout=%v err=%v", host, port, timeout, err)
	}
}

func TestProbeHTTPSuccessAndStatus(t *testing.T) {
	t.Parallel()
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Method != http.MethodGet {
			t.Errorf("method=%s", r.Method)
		}
		switch r.URL.Path {
		case "/ok":
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "SECRET-BODY-SHOULD-NOT-APPEAR")
		case "/created":
			w.WriteHeader(http.StatusCreated)
		case "/redirect":
			w.Header().Set("Location", "http://never-followed.invalid/elsewhere")
			w.WriteHeader(http.StatusFound)
			_, _ = io.WriteString(w, "redirect-body")
		case "/malformed-location":
			w.Header().Set("Location", "://not a url")
			w.WriteHeader(http.StatusMovedPermanently)
		case "/fail":
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = io.WriteString(w, "error-body-with-secret")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	for _, tc := range []struct {
		path string
		code int
		err  string
	}{
		{"/ok", 0, ""},
		{"/created", 0, ""},
		{"/redirect", 0, ""},
		{"/malformed-location", 0, ""},
		{"/fail", 1, "HTTP status 500"},
		{"/missing", 1, "HTTP status 404"},
	} {
		t.Run(tc.path, func(t *testing.T) {
			streams, out, errBuf := probeStreams(nil)
			got := runProbeHTTP([]string{"--url", server.URL + tc.path, "--timeout", "2"}, streams)
			if got != tc.code {
				t.Fatalf("code=%d stderr=%q", got, errBuf.String())
			}
			if out.Len() != 0 {
				t.Fatalf("stdout=%q", out.String())
			}
			if tc.err == "" {
				if errBuf.Len() != 0 {
					t.Fatalf("stderr=%q", errBuf.String())
				}
				return
			}
			if strings.TrimSpace(errBuf.String()) != tc.err {
				t.Fatalf("stderr=%q want %q", errBuf.String(), tc.err)
			}
			if strings.Contains(errBuf.String(), "SECRET") || strings.Contains(errBuf.String(), "error-body") {
				t.Fatalf("body leaked into stderr: %q", errBuf.String())
			}
			if strings.Contains(errBuf.String(), server.URL) {
				t.Fatalf("url leaked into stderr: %q", errBuf.String())
			}
		})
	}
	if hits.Load() < 6 {
		t.Fatalf("hits=%d", hits.Load())
	}
}

func TestProbeHTTPNoRedirectFollow(t *testing.T) {
	t.Parallel()
	var secondHits atomic.Int32
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		secondHits.Add(1)
		w.WriteHeader(http.StatusOK)
	}))
	defer second.Close()

	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", second.URL+"/followed")
		w.WriteHeader(http.StatusTemporaryRedirect)
	}))
	defer first.Close()

	streams, _, errBuf := probeStreams(nil)
	if code := runProbeHTTP([]string{"--url", first.URL, "--timeout", "2"}, streams); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errBuf.String())
	}
	if secondHits.Load() != 0 {
		t.Fatalf("followed redirect hits=%d", secondHits.Load())
	}
}

func selfSignedTLSConfig(t *testing.T) *tls.Config {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "probe-test"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Config{Certificates: []tls.Certificate{cert}}
}

func TestProbeHTTPSInsecureSkipVerify(t *testing.T) {
	t.Parallel()
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	server.TLS = selfSignedTLSConfig(t)
	server.StartTLS()
	defer server.Close()

	streams, _, errBuf := probeStreams(nil)
	if code := runProbeHTTP([]string{"--url", server.URL + "/ready", "--timeout", "2"}, streams); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errBuf.String())
	}
}

func TestProbeHTTPConnectionRefused(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	streams, _, errBuf := probeStreams(nil)
	code := runProbeHTTP([]string{"--url", "http://" + addr + "/ready", "--timeout", "1"}, streams)
	if code != 1 {
		t.Fatalf("code=%d stderr=%q", code, errBuf.String())
	}
	msg := strings.TrimSpace(errBuf.String())
	if msg != "connection refused" {
		t.Fatalf("stderr=%q", errBuf.String())
	}
	if strings.Contains(errBuf.String(), addr) {
		t.Fatalf("address leaked: %q", errBuf.String())
	}
}

func TestProbeHTTPTimeout(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	streams, _, errBuf := probeStreams(nil)
	start := time.Now()
	code := runProbeHTTP([]string{"--url", server.URL, "--timeout", "0.2"}, streams)
	elapsed := time.Since(start)
	if code != 1 {
		t.Fatalf("code=%d stderr=%q", code, errBuf.String())
	}
	if msg := strings.TrimSpace(errBuf.String()); msg != "connection timed out" {
		t.Fatalf("stderr=%q", errBuf.String())
	}
	if elapsed > 1500*time.Millisecond {
		t.Fatalf("timeout too slow: %s", elapsed)
	}
}

func TestProbeTCPSuccessAndFailure(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}

	streams, out, errBuf := probeStreams(nil)
	if code := runProbeTCP([]string{"--host", host, "--port", port, "--timeout", "1"}, streams); code != 0 || out.Len() != 0 || errBuf.Len() != 0 {
		t.Fatalf("success code stderr=%q out=%q", errBuf.String(), out.String())
	}

	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedHost, closedPort, err := net.SplitHostPort(closed.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = closed.Close()

	streams, _, errBuf = probeStreams(nil)
	if code := runProbeTCP([]string{"--host", closedHost, "--port", closedPort, "--timeout", "1"}, streams); code != 1 {
		t.Fatalf("refused code=%d", code)
	}
	if strings.TrimSpace(errBuf.String()) != "connection refused" {
		t.Fatalf("stderr=%q", errBuf.String())
	}
	if strings.Contains(errBuf.String(), closedHost) || strings.Contains(errBuf.String(), closedPort) {
		t.Fatalf("address leaked: %q", errBuf.String())
	}
}

func TestProbeTCPFromEnv(t *testing.T) {
	t.Parallel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	streams, _, errBuf := probeStreams(map[string]string{
		"LANDO_PROBE_HOST": host,
		"LANDO_PROBE_PORT": port,
	})
	if code := runProbeTCP([]string{"--timeout", "1"}, streams); code != 0 {
		t.Fatalf("code=%d stderr=%q", code, errBuf.String())
	}
}

func TestDispatchProbeSubcommands(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	var out, errBuf bytes.Buffer
	code := dispatch("helper", []string{"probe-http", "--url", server.URL, "--timeout", "2"}, helperIO{
		stdout: &out, stderr: &errBuf,
	})
	if code != 0 || out.Len() != 0 || errBuf.Len() != 0 {
		t.Fatalf("http dispatch code=%d out=%q err=%q", code, out.String(), errBuf.String())
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	host, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errBuf.Reset()
	code = dispatch("helper", []string{"probe-tcp", "--host", host, "--port", port, "--timeout", "1"}, helperIO{
		stdout: &out, stderr: &errBuf,
	})
	if code != 0 || out.Len() != 0 || errBuf.Len() != 0 {
		t.Fatalf("tcp dispatch code=%d out=%q err=%q", code, out.String(), errBuf.String())
	}

	out.Reset()
	errBuf.Reset()
	code = dispatch("helper", []string{"probe-http"}, helperIO{stdout: &out, stderr: &errBuf})
	if code != 1 || !strings.Contains(errBuf.String(), "probe-http") {
		t.Fatalf("usage code=%d stderr=%q", code, errBuf.String())
	}
}

func TestProbeHTTPUsageDoesNotLeakURL(t *testing.T) {
	t.Parallel()
	secret := fmt.Sprintf("http://user:secret-token@127.0.0.1:%d/path", 1)
	streams, _, errBuf := probeStreams(nil)
	_ = runProbeHTTP([]string{"--url", secret}, streams)
	if strings.Contains(errBuf.String(), "secret-token") {
		t.Fatalf("credential leaked: %q", errBuf.String())
	}
}
