package api

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// TransportOptions configures outbound HTTP.
type TransportOptions struct {
	// Proxy overrides HTTPS_PROXY/HTTP_PROXY when non-empty. NO_PROXY is
	// honoured either way.
	Proxy string
	// CAFile is an extra PEM bundle appended to the system roots.
	CAFile string
}

// NewTransport builds an http.Transport with proxy and CA settings. The same
// transport serves REST calls and long-lived SSE streams.
func NewTransport(o TransportOptions) (*http.Transport, error) {
	proxy, err := ProxyFunc(o.Proxy)
	if err != nil {
		return nil, err
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if o.CAFile != "" {
		pool, err := LoadCAPool(o.CAFile)
		if err != nil {
			return nil, err
		}
		tlsCfg.RootCAs = pool
	}
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	return &http.Transport{
		Proxy:                 proxy,
		DialContext:           dialer.DialContext,
		TLSClientConfig:       tlsCfg,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          20,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 45 * time.Second,
		ExpectContinueTimeout: time.Second,
	}, nil
}

// LoadCAPool returns the system pool plus the certificates in file.
func LoadCAPool(file string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("读取 ca_file 失败: %w", err)
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if !pool.AppendCertsFromPEM(pem) {
		return nil, fmt.Errorf("ca_file %s 中没有可用的 PEM 证书", file)
	}
	return pool, nil
}

// ProxyFunc returns the proxy selector. With an explicit proxy it is used for
// every host not matched by NO_PROXY; otherwise the environment is used.
func ProxyFunc(explicit string) (func(*http.Request) (*url.URL, error), error) {
	if explicit == "" {
		return http.ProxyFromEnvironment, nil
	}
	pu, err := url.Parse(explicit)
	if err != nil || pu.Host == "" {
		return nil, fmt.Errorf("proxy %q 无效", explicit)
	}
	noProxy := firstEnv("NO_PROXY", "no_proxy")
	return func(r *http.Request) (*url.URL, error) {
		if BypassProxy(r.URL.Host, noProxy) {
			return nil, nil
		}
		return pu, nil
	}, nil
}

// EffectiveProxy describes which proxy (if any) is used for target. Used by doctor.
func EffectiveProxy(explicit, target string) (string, error) {
	f, err := ProxyFunc(explicit)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return "", err
	}
	u, err := f(req)
	if err != nil {
		return "", err
	}
	if u == nil {
		return "", nil
	}
	return redactURL(u), nil
}

func redactURL(u *url.URL) string {
	c := *u
	if c.User != nil {
		c.User = url.UserPassword(c.User.Username(), "***")
	}
	return c.String()
}

func firstEnv(keys ...string) string {
	for _, k := range keys {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return ""
}

// BypassProxy reports whether hostport matches the NO_PROXY list. Loopback
// addresses always bypass, like net/http does.
func BypassProxy(hostport, noProxy string) bool {
	host := hostport
	port := ""
	if h, p, err := net.SplitHostPort(hostport); err == nil {
		host, port = h, p
	}
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	if ip != nil && ip.IsLoopback() {
		return true
	}
	for _, entry := range strings.Split(noProxy, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		if entry == "*" {
			return true
		}
		if _, cidr, err := net.ParseCIDR(entry); err == nil {
			if ip != nil && cidr.Contains(ip) {
				return true
			}
			continue
		}
		eHost, ePort := entry, ""
		if h, p, err := net.SplitHostPort(entry); err == nil {
			eHost, ePort = h, p
		}
		eHost = strings.Trim(eHost, "[]")
		if ePort != "" && ePort != port {
			continue
		}
		if eip := net.ParseIP(eHost); eip != nil {
			if ip != nil && eip.Equal(ip) {
				return true
			}
			continue
		}
		eHost = strings.TrimPrefix(eHost, "*")
		if strings.HasPrefix(eHost, ".") {
			if strings.HasSuffix(host, eHost) || host == eHost[1:] {
				return true
			}
			continue
		}
		if host == eHost || strings.HasSuffix(host, "."+eHost) {
			return true
		}
	}
	return false
}
