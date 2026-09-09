package speedtest

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type deadlineRecorder struct {
	*httptest.ResponseRecorder
	readDeadline, writeDeadline time.Time
	writes                      int
	stop                        bool
}

func (w *deadlineRecorder) SetReadDeadline(d time.Time) error  { w.readDeadline = d; return nil }
func (w *deadlineRecorder) SetWriteDeadline(d time.Time) error { w.writeDeadline = d; return nil }
func (w *deadlineRecorder) Write(p []byte) (int, error) {
	w.writes++
	if w.stop {
		return 0, io.ErrClosedPipe
	}
	return w.ResponseRecorder.Write(p)
}

func TestDownloadParameters(t *testing.T) {
	for _, tc := range []struct {
		query        string
		status, size int
	}{
		{"bytes=131073&chunk=1", 200, 131073},
		{"size=0.001", 200, 1048},
		{"bytes=1&size=bad", 200, 1},
		{"bytes=0", 400, 0}, {"bytes=-1", 400, 0},
		{"bytes=oops", 400, 0}, {"bytes=9223372036854775808", 400, 0},
		{"size=NaN", 400, 0}, {"size=Inf", 400, 0},
		{"size=-1", 400, 0}, {"chunk=0", 400, 0}, {"chunk=oops", 400, 0},
	} {
		t.Run(tc.query, func(t *testing.T) {
			w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
			DownloadHandler(w, httptest.NewRequest("GET", "/?"+tc.query, nil))
			if w.Code != tc.status {
				t.Fatalf("status %d", w.Code)
			}
			if tc.status != 200 {
				return
			}
			if w.Body.Len() != tc.size {
				t.Fatalf("size %d", w.Body.Len())
			}
			if w.Flushed || w.writes > 3 {
				t.Fatalf("amplification: writes=%d flush=%v", w.writes, w.Flushed)
			}
			if !strings.Contains(w.Header().Get("Cache-Control"), "no-transform") {
				t.Fatal("missing no-transform")
			}
			if time.Until(w.readDeadline) <= 0 || time.Until(w.writeDeadline) > requestTimeout {
				t.Fatal("invalid deadlines")
			}
		})
	}
}

func TestDownloadLimitsAndCancellation(t *testing.T) {
	for _, query := range []string{"bytes=9223372036854775807&chunk=9223372036854775807", "size=1e300", ""} {
		w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder(), stop: true}
		DownloadHandler(w, httptest.NewRequest("GET", "/?"+query, nil))
		want := "1073741824"
		if query == "" {
			want = "10485760"
		}
		if w.Header().Get("Content-Length") != want || w.writes != 1 {
			t.Fatalf("headers=%v writes=%d", w.Header(), w.writes)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	DownloadHandler(w, httptest.NewRequest("GET", "/?bytes=100", nil).WithContext(ctx))
	if w.writes != 0 || len(transferSlots) != 0 {
		t.Fatal("cancelled transfer not released")
	}
}

func TestMethods(t *testing.T) {
	for _, h := range []http.HandlerFunc{DownloadHandler, UploadHandler, PingHandler} {
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("DELETE", "/", nil))
		if w.Code != 405 || w.Header().Get("Allow") == "" {
			t.Fatal("method not rejected")
		}
	}
}

func TestTransferCapacity(t *testing.T) {
	for i := 0; i < maxConcurrentTransfers; i++ {
		transferSlots <- struct{}{}
	}
	defer func() {
		for i := 0; i < maxConcurrentTransfers; i++ {
			<-transferSlots
		}
	}()
	w := httptest.NewRecorder()
	DownloadHandler(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 || w.Header().Get("Retry-After") == "" {
		t.Fatal("capacity not enforced")
	}
	w = httptest.NewRecorder()
	UploadHandler(w, httptest.NewRequest("POST", "/", nil))
	if w.Code != 503 {
		t.Fatal("upload capacity not enforced")
	}
}

func TestUploadAndPingHTTP(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/upload", UploadHandler)
	mux.HandleFunc("/ping", PingHandler)
	s := httptest.NewServer(mux)
	defer s.Close()
	for _, method := range []string{"POST", "PUT"} {
		r, _ := http.NewRequest(method, s.URL+"/upload", strings.NewReader("payload"))
		resp, err := s.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(body), `"receivedBytes":7`) {
			t.Fatalf("upload: %s", body)
		}
	}
	resp, err := s.Client().Get(s.URL + "/ping")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.Status)
	}
}

type oversizedBody struct{}

func (oversizedBody) Read(p []byte) (int, error) { return len(p), nil }
func (oversizedBody) Close() error               { return nil }

func TestUploadSizeLimit(t *testing.T) {
	for _, length := range []int64{-1, int64(maxUploadSizeMB*1024*1024) + 1} {
		w := &deadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
		r := httptest.NewRequest("POST", "/", nil)
		r.Body = oversizedBody{}
		r.ContentLength = length
		UploadHandler(w, r)
		if w.Code != 413 || len(transferSlots) != 0 {
			t.Fatalf("status=%d slots=%d", w.Code, len(transferSlots))
		}
	}
}

func TestPayloadCompression(t *testing.T) {
	var buf bytes.Buffer
	z := gzip.NewWriter(&buf)
	_, _ = z.Write(downloadPayload)
	_ = z.Close()
	if buf.Len() < len(downloadPayload)*99/100 {
		t.Fatal("payload is compressible")
	}
}

func TestDeadlineRequired(t *testing.T) {
	w := httptest.NewRecorder()
	DownloadHandler(w, httptest.NewRequest("GET", "/", nil))
	if w.Code != 503 || len(transferSlots) != 0 {
		t.Fatal("unsupported deadline must fail closed")
	}
}

type shortDeadlineWriter struct{ http.ResponseWriter }

func (w shortDeadlineWriter) SetReadDeadline(time.Time) error {
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(time.Now().Add(30 * time.Millisecond))
}
func (w shortDeadlineWriter) SetWriteDeadline(time.Time) error {
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(time.Now().Add(time.Second))
}

func TestSlowUploadDeadline(t *testing.T) {
	finished := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		UploadHandler(shortDeadlineWriter{w}, r)
	}))
	defer s.Close()
	conn, err := net.Dial("tcp", s.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	_, err = fmt.Fprint(conn, "POST / HTTP/1.1\r\nHost: test\r\nContent-Length: 100\r\n\r\nx")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 408 {
		t.Fatal(resp.Status)
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("upload stuck after deadline")
	}
	if len(transferSlots) != 0 {
		t.Fatal("slot leaked after timeout")
	}
}

func TestRejectedRequestDoesNotDrainSlowBody(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(DownloadHandler))
	defer s.Close()
	conn, err := net.Dial("tcp", s.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(time.Second))
	_, err = fmt.Fprint(conn, "GET /?chunk=bad HTTP/1.1\r\nHost: test\r\nContent-Length: 100\r\n\r\nx")
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 400 || !resp.Close {
		t.Fatalf("status=%d close=%v", resp.StatusCode, resp.Close)
	}
}
