package main

import (
	"bufio"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"pltester/config"
	"pltester/nodes"

	"golang.org/x/net/websocket"
)

func TestCORSMiddleware(t *testing.T) {
	const origin = "https://client.example"
	for _, tt := range []struct {
		name, method, origin, requestMethod, requestHeaders string
		origins                                             []string
		status                                              int
		acao                                                string
		called                                              bool
	}{
		{name: "default public", method: "GET", origin: origin, status: 204, acao: "*", called: true},
		{name: "explicit public", method: "GET", origins: []string{"*"}, origin: origin, status: 204, acao: "*", called: true},
		{name: "public without origin", method: "GET", status: 204, acao: "*", called: true},
		{name: "allowed", method: "POST", origins: []string{origin}, origin: origin, status: 204, acao: origin, called: true},
		{name: "second allowed", method: "PUT", origins: []string{"https://other.example", origin}, origin: origin, status: 204, acao: origin, called: true},
		{name: "no origin nonbrowser", method: "GET", origins: []string{origin}, status: 204, called: true},
		{name: "empty list nonbrowser", method: "GET", origins: []string{}, status: 204, called: true},
		{name: "empty list browser", method: "GET", origins: []string{}, origin: origin, status: 403},
		{name: "denied", method: "GET", origins: []string{origin}, origin: "https://evil.example", status: 403},
		{name: "suffix denied", method: "GET", origins: []string{origin}, origin: origin + ".evil.example", status: 403},
		{name: "null denied", method: "GET", origins: []string{origin}, origin: "null", status: 403},
		{name: "public preflight", method: "OPTIONS", origin: origin, requestMethod: "PUT", requestHeaders: "Content-Type, Authorization", status: 200, acao: "*"},
		{name: "allowed preflight", method: "OPTIONS", origins: []string{origin}, origin: origin, requestMethod: "POST", requestHeaders: "content-type, AUTHORIZATION", status: 200, acao: origin},
		{name: "get preflight", method: "OPTIONS", origins: []string{origin}, origin: origin, requestMethod: "GET", status: 200, acao: origin},
		{name: "options preflight", method: "OPTIONS", origins: []string{origin}, origin: origin, requestMethod: "OPTIONS", status: 200, acao: origin},
		{name: "denied preflight", method: "OPTIONS", origins: []string{origin}, origin: "https://evil.example", requestMethod: "PUT", status: 403},
		{name: "delete preflight", method: "OPTIONS", origin: origin, requestMethod: "DELETE", status: 403},
		{name: "patch preflight", method: "OPTIONS", origin: origin, requestMethod: "PATCH", status: 403},
		{name: "head preflight", method: "OPTIONS", origin: origin, requestMethod: "HEAD", status: 403},
		{name: "bad header preflight", method: "OPTIONS", origin: origin, requestMethod: "POST", requestHeaders: "Content-Type, X-Admin", status: 403},
		{name: "nonbrowser options", method: "OPTIONS", origins: []string{origin}, status: 200},
	} {
		t.Run(tt.name, func(t *testing.T) {
			called := false
			handler := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			}), config.Config{AllowedOrigins: tt.origins})
			r := httptest.NewRequest(tt.method, "/speedtest/upload", nil)
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			r.Header.Set("Access-Control-Request-Method", tt.requestMethod)
			r.Header.Set("Access-Control-Request-Headers", tt.requestHeaders)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tt.status || w.Header().Get("Access-Control-Allow-Origin") != tt.acao || called != tt.called {
				t.Fatalf("response = %d %v, called = %v", w.Code, w.Header(), called)
			}
			if w.Header().Get("Access-Control-Allow-Credentials") != "" {
				t.Fatal("credentials must not be enabled")
			}
			if tt.origins != nil && !strings.Contains(strings.Join(w.Header().Values("Vary"), ","), "Origin") && tt.acao != "*" {
				t.Fatal("allowlist responses must vary by Origin")
			}
			if tt.status < 400 && w.Header().Get("Access-Control-Expose-Headers") != "Retry-After" {
				t.Fatal("Retry-After is not exposed")
			}
			if tt.method == "OPTIONS" && tt.status == 200 {
				if w.Header().Get("Access-Control-Allow-Methods") != "GET, POST, PUT, OPTIONS" || w.Header().Get("Access-Control-Allow-Headers") != "Content-Type, Authorization" {
					t.Fatalf("unexpected preflight headers: %v", w.Header())
				}
			}
		})
	}
}

func TestCORSWebSocketBeforeUpgrade(t *testing.T) {
	for _, tt := range []struct {
		name, origin string
		want         int
	}{
		{"denied", "https://evil.example", http.StatusForbidden},
		{"allowed reaches upgrade", "https://client.example", http.StatusBadRequest},
		{"no origin reaches upgrade", "", http.StatusBadRequest},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var called atomic.Bool
			mux := http.NewServeMux()
			wsHandler := websocket.Handler(func(*websocket.Conn) { t.Error("unexpected completed upgrade") })
			mux.Handle("/ws", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called.Store(true)
				wsHandler.ServeHTTP(w, r)
			}))
			server := httptest.NewServer(corsMiddleware(mux, config.Config{AllowedOrigins: []string{"https://client.example"}}))
			defer server.Close()
			r, err := http.NewRequest(http.MethodGet, server.URL+"/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			if tt.origin != "" {
				r.Header.Set("Origin", tt.origin)
			}
			// Missing Sec-WebSocket-Version makes an allowed request fail in the upgrader.
			r.Header.Set("Connection", "Upgrade")
			r.Header.Set("Upgrade", "websocket")
			client := server.Client()
			client.Timeout = 5 * time.Second
			response, err := client.Do(r)
			if err != nil {
				t.Fatal(err)
			}
			defer response.Body.Close()
			if response.StatusCode != tt.want || called.Load() != (tt.want != http.StatusForbidden) {
				t.Fatalf("status = %d, reached upgrader = %v", response.StatusCode, called.Load())
			}
			if tt.want == http.StatusForbidden && (response.Header.Get("Access-Control-Allow-Origin") != "" || response.Header.Get("Sec-WebSocket-Version") != "") {
				t.Fatalf("denied origin reached CORS approval or upgrade: %v", response.Header)
			}
		})
	}
}

func TestCORSInvalidHeaders(t *testing.T) {
	for _, tt := range []struct {
		name    string
		headers http.Header
	}{
		{"empty origin", http.Header{"Origin": {""}}},
		{"duplicate origin", http.Header{"Origin": {"https://client.example", "https://evil.example"}}},
		{"duplicate preflight method", http.Header{"Origin": {"https://client.example"}, "Access-Control-Request-Method": {"GET", "DELETE"}}},
		{"multiple preflight headers", http.Header{"Origin": {"https://client.example"}, "Access-Control-Request-Headers": {"Content-Type", "X-Admin"}}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			handler := corsMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
				t.Fatal("invalid request reached handler")
			}), config.Config{AllowedOrigins: []string{"https://client.example"}})
			r := httptest.NewRequest(http.MethodOptions, "/ws", nil)
			r.Header = tt.headers
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != http.StatusForbidden || w.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Fatalf("unexpected response: %d %v", w.Code, w.Header())
			}
		})
	}
}

func TestNodesWithCORS(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/nodes", nodes.Handler(nil))
	handler := corsMiddleware(mux, config.Config{})
	for _, tt := range []struct {
		method string
		status int
	}{
		{http.MethodGet, http.StatusOK},
		{http.MethodPost, http.StatusMethodNotAllowed},
		{http.MethodOptions, http.StatusOK},
	} {
		t.Run(tt.method, func(t *testing.T) {
			r := httptest.NewRequest(tt.method, "/api/nodes", nil)
			r.Header.Set("Origin", "https://client.example")
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, r)
			if w.Code != tt.status || w.Header().Get("Access-Control-Allow-Origin") != "*" {
				t.Fatalf("unexpected response: %d %v", w.Code, w.Header())
			}
		})
	}
}

func TestOriginConfigurationMatchesBrowserSerialization(t *testing.T) {
	for _, tc := range []struct{ configured, browser string }{
		{"https://Example.COM:443", "https://example.com"},
		{"http://localhost:080", "http://localhost"},
		{"https://[2001:0db8:0:0:0:0:0:1]:443", "https://[2001:db8::1]"},
		{"http://[::ffff:127.0.0.1]:8080", "http://[::ffff:7f00:1]:8080"},
		{"https://例子.测试", "https://xn--fsqu00a.xn--0zwm56d"},
	} {
		t.Run(tc.configured, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "config.json")
			if err := os.WriteFile(path, []byte(fmt.Sprintf(`{"allowed_origins":[%q]}`, tc.configured)), 0600); err != nil {
				t.Fatal(err)
			}
			cfg, err := config.LoadConfig(path)
			if err != nil {
				t.Fatal(err)
			}
			h := corsMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }), cfg)
			r := httptest.NewRequest("POST", "/speedtest/upload", nil)
			r.Header.Set("Origin", tc.browser)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 204 || w.Header().Get("Access-Control-Allow-Origin") != tc.browser {
				t.Fatalf("canonical Origin rejected: %d, origins=%v", w.Code, cfg.AllowedOrigins)
			}
		})
	}
}

func TestCORSRejectionDoesNotDrainSlowBody(t *testing.T) {
	s := httptest.NewServer(corsMiddleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Error("denied request reached the handler")
	}), config.Config{AllowedOrigins: []string{"https://allowed.test"}}))
	defer s.Close()
	c, err := net.Dial("tcp", s.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	fmt.Fprint(c, "POST /speedtest/upload HTTP/1.1\r\nHost: test\r\nOrigin: https://denied.test\r\nContent-Length: 100\r\n\r\nx")
	resp, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 403 || !resp.Close {
		t.Fatalf("unexpected rejection: %d close=%v", resp.StatusCode, resp.Close)
	}
}
