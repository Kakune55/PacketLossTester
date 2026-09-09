package ipinfo

import (
	"context"
	"errors"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestLookupURL(t *testing.T) {
	for _, tt := range []struct {
		name, base, target, scheme, host, path string
		keys                                   []string
	}{
		{"default", "", "8.8.8.8", "http", "ip-api.com", "/json/8.8.8.8", nil},
		{"root", "https://example.com", "8.8.8.8", "https", "example.com", "/8.8.8.8", nil},
		{"path", "https://example.com/proxy/json", "8.8.8.8", "https", "example.com", "/proxy/json/8.8.8.8", nil},
		{"slash query", "https://example.com/proxy/json/?key=a%2Fb&key=c%2Bd&fields=old&lang=en", "8.8.8.8", "https", "example.com", "/proxy/json/8.8.8.8", []string{"a/b", "c+d"}},
		{"query", "https://example.com/json?key=secret", "8.8.8.8", "https", "example.com", "/json/8.8.8.8", []string{"secret"}},
		{"userinfo", "https://user:secret@example.com/json?key=secret", "8.8.8.8", "https", "example.com", "/json/8.8.8.8", []string{"secret"}},
		{"IPv6", "http://[::1]:8080/json?key=secret", "2001:4860:4860::8888", "http", "::1", "/json/2001:4860:4860::8888", []string{"secret"}},
		{"self", "https://example.com/json?key=secret", "", "https", "example.com", "/json/", []string{"secret"}},
		{"escaped path", "https://example.com/proxy%2Ftenant/json?key=secret", "8.8.8.8", "https", "example.com", "/proxy%2Ftenant/json/8.8.8.8", []string{"secret"}},
		{"bare host", "example.com:8080/json?key=secret", "8.8.8.8", "https", "example.com", "/json/8.8.8.8", []string{"secret"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := NewService("", tt.base)
			calls := 0
			s.httpClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodGet || r.URL.Scheme != tt.scheme || r.URL.Hostname() != tt.host || r.URL.EscapedPath() != tt.path {
					t.Fatalf("unexpected request: %s %s", r.Method, r.URL)
				}
				q := r.URL.Query()
				if tt.name == "userinfo" {
					user, password, ok := r.BasicAuth()
					if !ok || user != "user" || password != "secret" {
						t.Fatal("URL basic authentication was not preserved")
					}
				}
				if (tt.name == "IPv6" || tt.name == "bare host") && r.URL.Port() != "8080" {
					t.Fatal("custom port was not preserved")
				}
				if !reflect.DeepEqual(q["key"], tt.keys) || !reflect.DeepEqual(q["fields"], []string{ipAPIFields}) || !reflect.DeepEqual(q["lang"], []string{ipAPILang}) {
					t.Fatalf("unexpected query: %v", q)
				}
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"status":"success","query":"8.8.8.8","country":"US","regionName":"California","asname":"GOOGLE","lat":1.5}`))}, nil
			})
			// Repeated lookups must not mutate the shared base URL.
			for range 2 {
				entry := s.lookup(context.Background(), tt.target, lookupOptions{allowSelf: true})
				if !entry.Success || entry.Source != tt.host || entry.Region != "California" || entry.ASName != "GOOGLE" || entry.Latitude != 1.5 {
					t.Fatalf("unexpected entry: %+v", entry)
				}
			}
			if calls != 2 {
				t.Fatalf("requests = %d, want 2", calls)
			}
		})
	}
}

func TestLookupResponseContract(t *testing.T) {
	for _, body := range []string{`{"status":"fail","message":"invalid query"}`, `{"country":"US"}`, `not json`} {
		t.Run(body, func(t *testing.T) {
			s := NewService("", "https://example.com/json")
			s.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(body))}, nil
			})
			entry := s.lookup(context.Background(), "8.8.8.8", lookupOptions{})
			if entry.Success || entry.Message == "" {
				t.Fatalf("unexpected entry: %+v", entry)
			}
		})
	}
}

func TestInvalidServiceURL(t *testing.T) {
	s := NewService("", "ftp://example.com/json?key=secret")
	s.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid URL must not make an HTTP request")
		return nil, nil
	})
	entry := s.lookup(context.Background(), "8.8.8.8", lookupOptions{})
	if entry.Success || !strings.Contains(entry.Message, "ip_api_custom_host") || strings.Contains(entry.Message, "secret") {
		t.Fatalf("unexpected entry: %+v", entry)
	}
}

func TestLookupTransportErrorDoesNotExposeCredentials(t *testing.T) {
	s := NewService("", "https://user:secret@example.com/json?key=secret")
	s.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection refused")
	})
	entry := s.lookup(context.Background(), "8.8.8.8", lookupOptions{})
	if entry.Success || entry.Message == "" || strings.Contains(entry.Message, "secret") || strings.Contains(entry.Message, "key=") {
		t.Fatalf("unsafe error response: %+v", entry)
	}
}
