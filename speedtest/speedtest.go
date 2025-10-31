package speedtest

import (
	"encoding/json"
	"errors"
	"io"
	"math/rand"
	"net/http"
	"strconv"
	"time"
)

const (
	defaultDownloadSizeMB = 10.0
	maxDownloadSizeMB     = 100.0
	maxUploadSizeMB       = 100.0
)

type uploadResponse struct {
	ReceivedBytes int64 `json:"receivedBytes"`
}

// DownloadHandler streamed random payload to benchmark downstream throughput.
func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sizeBytes := int64(defaultDownloadSizeMB * 1024 * 1024)
	if raw := r.URL.Query().Get("bytes"); raw != "" {
		if parsed, err := strconv.ParseInt(raw, 10, 64); err == nil && parsed > 0 {
			sizeBytes = parsed
		}
	} else if raw := r.URL.Query().Get("size"); raw != "" {
		if parsed, err := strconv.ParseFloat(raw, 64); err == nil && parsed > 0 {
			sizeBytes = int64(parsed * 1024 * 1024)
		}
	}

	maxBytes := int64(maxDownloadSizeMB * 1024 * 1024)
	if sizeBytes > maxBytes {
		sizeBytes = maxBytes
	}
	if sizeBytes < 1 {
		sizeBytes = 1
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(sizeBytes, 10))
	w.Header().Set("Cache-Control", "no-store")

	randSrc := rand.New(rand.NewSource(time.Now().UnixNano()))
	buf := make([]byte, 64*1024)

	remaining := sizeBytes
	for remaining > 0 {
		chunk := len(buf)
		if remaining < int64(chunk) {
			chunk = int(remaining)
		}
		if _, err := randSrc.Read(buf[:chunk]); err != nil {
			http.Error(w, "failed to generate payload", http.StatusInternalServerError)
			return
		}
		if _, err := w.Write(buf[:chunk]); err != nil {
			return
		}
		remaining -= int64(chunk)
	}
}

// UploadHandler drains the request body to benchmark upstream throughput.
func UploadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	maxBytes := int64(maxUploadSizeMB * 1024 * 1024)
	reader := http.MaxBytesReader(w, r.Body, maxBytes)
	defer reader.Close()

	received, err := io.Copy(io.Discard, reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		if errors.Is(err, http.ErrBodyReadAfterClose) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "failed to read payload", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(uploadResponse{ReceivedBytes: received})
}

// PingHandler returns a lightweight JSON response for latency measurements.
func PingHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
