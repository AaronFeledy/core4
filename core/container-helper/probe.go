package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"syscall"
	"time"
)

const (
	probeUsageHTTP = "Usage: lando-container-helper probe-http --url <http(s)://...> --timeout <seconds>"
	probeUsageTCP  = "Usage: lando-container-helper probe-tcp --host <host> --port <port> --timeout <seconds>"
)

var errProbeUsageHTTP = errors.New(probeUsageHTTP)
var errProbeUsageTCP = errors.New(probeUsageTCP)

// probeHTTPTransport performs exactly one request. It never follows redirects
// (including a malformed Location) and never verifies TLS certificates: readiness
// is reachability, not trust.
func probeHTTPTransport(timeout time.Duration) *http.Transport {
	dialer := &net.Dialer{Timeout: timeout}
	return &http.Transport{
		Proxy:                 nil,
		DialContext:           dialer.DialContext,
		ForceAttemptHTTP2:     false,
		MaxIdleConns:          1,
		IdleConnTimeout:       timeout,
		TLSHandshakeTimeout:   timeout,
		ExpectContinueTimeout: timeout,
		ResponseHeaderTimeout: timeout,
		DisableKeepAlives:     true,
		//nolint:gosec // G402: service readiness intentionally skips certificate verification.
		TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
	}
}

func parseProbeTimeout(seconds float64) (time.Duration, bool) {
	nanos := seconds * float64(time.Second)
	if !(nanos >= 1 && nanos < float64(math.MaxInt64)) {
		return 0, false
	}
	return time.Duration(nanos), true
}

func parseProbeHTTPArgs(args []string) (string, time.Duration, error) {
	flags := flag.NewFlagSet("probe-http", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	rawURL := flags.String("url", "", "")
	seconds := flags.Float64("timeout", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return "", 0, errProbeUsageHTTP
	}
	timeout, ok := parseProbeTimeout(*seconds)
	parsed, parseErr := url.Parse(*rawURL)
	if !ok || parseErr != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", 0, errProbeUsageHTTP
	}
	return *rawURL, timeout, nil
}

func parseProbeTCPArgs(args []string, env map[string]string) (string, string, time.Duration, error) {
	flags := flag.NewFlagSet("probe-tcp", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	host := flags.String("host", env["LANDO_PROBE_HOST"], "")
	port := flags.String("port", env["LANDO_PROBE_PORT"], "")
	seconds := flags.Float64("timeout", 0, "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return "", "", 0, errProbeUsageTCP
	}
	timeout, ok := parseProbeTimeout(*seconds)
	portNum, portErr := strconv.Atoi(*port)
	if !ok || *host == "" || portErr != nil || portNum < 1 || portNum > 65535 {
		return "", "", 0, errProbeUsageTCP
	}
	return *host, *port, timeout, nil
}

func probeNetworkError(err error) string {
	var netErr net.Error
	var dnsErr *net.DNSError
	var tlsErr tls.RecordHeaderError
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "connection timed out"
	}
	switch {
	case errors.Is(err, syscall.ECONNREFUSED):
		return "connection refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH):
		return "network unreachable"
	case errors.As(err, &dnsErr):
		return "host lookup failed"
	case errors.As(err, &tlsErr):
		return "TLS handshake failed"
	default:
		return "request failed"
	}
}

func runProbeHTTPOnce(rawURL string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return errors.New(probeNetworkError(err))
	}

	// RoundTrip issues one request and never follows redirects.
	resp, err := probeHTTPTransport(timeout).RoundTrip(req)
	if err != nil {
		return errors.New(probeNetworkError(err))
	}
	// Do not read the body; close only so the connection can be released.
	_ = resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP status %d", resp.StatusCode)
	}
	return nil
}

func runProbeTCPOnce(host, port string, timeout time.Duration) error {
	address := net.JoinHostPort(host, port)
	conn, err := net.DialTimeout("tcp", address, timeout)
	if err != nil {
		return errors.New(probeNetworkError(err))
	}
	_ = conn.Close()
	return nil
}

func runProbeHTTP(args []string, streams helperIO) int {
	rawURL, timeout, err := parseProbeHTTPArgs(args)
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 1
	}
	if err := runProbeHTTPOnce(rawURL, timeout); err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 1
	}
	return 0
}

func runProbeTCP(args []string, streams helperIO) int {
	host, port, timeout, err := parseProbeTCPArgs(args, streams.env)
	if err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 1
	}
	if err := runProbeTCPOnce(host, port, timeout); err != nil {
		fmt.Fprintln(streams.stderr, err)
		return 1
	}
	return 0
}
