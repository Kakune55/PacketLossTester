package speedtest

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"strconv"
	"time"
)

const (
	defaultDownloadSizeMB  = 10.0
	maxDownloadSizeMB      = 1024.0
	maxUploadSizeMB        = 1024.0
	defaultChunkBytes      = 64 * 1024
	maxChunkBytes          = 100 * 1024 * 1024
	requestTimeout         = 2 * time.Minute
	maxConcurrentTransfers = 8
)

var downloadPayload = newDownloadPayload(1024 * 1024)
var transferSlots = make(chan struct{}, maxConcurrentTransfers)

type uploadResponse struct {
	ReceivedBytes int64 `json:"receivedBytes"`
}

func newDownloadPayload(size int) []byte {
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		panic(err)
	}
	return buf
}

// Deadlines interrupt blocked socket I/O; a context timeout alone does not.
func beginTransfer(w http.ResponseWriter) (func(), bool) {
	select {
	case transferSlots <- struct{}{}:
	default:
		w.Header().Set("Connection", "close")
		w.Header().Set("Retry-After", "5")
		http.Error(w, "too many transfers", http.StatusServiceUnavailable)
		return nil, false
	}
	release := func() { <-transferSlots }
	controller := http.NewResponseController(w)
	deadline := time.Now().Add(requestTimeout)
	if err := controller.SetReadDeadline(deadline); err != nil {
		release()
		http.Error(w, "read deadline unavailable", http.StatusServiceUnavailable)
		return nil, false
	}
	if err := controller.SetWriteDeadline(deadline); err != nil {
		release()
		http.Error(w, "write deadline unavailable", http.StatusServiceUnavailable)
		return nil, false
	}
	// net/http resets deadlines for the next request; do not clear a deadline
	// here before its buffered response has been written to the connection.
	return release, true
}

func parsePositiveInt64(raw string) (int64, bool) {
	parsed, err := strconv.ParseInt(raw, 10, 64)
	return parsed, err == nil && parsed > 0
}

// DownloadHandler streams a reusable payload to benchmark downstream throughput.
func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	// Rejected requests must not drain an untrusted body without a deadline.
	w.Header().Set("Connection", "close")
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sizeBytes := int64(defaultDownloadSizeMB * 1024 * 1024)
	if raw := r.URL.Query().Get("bytes"); raw != "" {
		if parsed, ok := parsePositiveInt64(raw); ok {
			sizeBytes = parsed
		} else {
			http.Error(w, "invalid bytes", http.StatusBadRequest)
			return
		}
	} else if raw := r.URL.Query().Get("size"); raw != "" {
		parsed, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) || parsed <= 0 {
			http.Error(w, "invalid size", http.StatusBadRequest)
			return
		}
		sizeBytes = int64(math.Min(parsed, maxDownloadSizeMB) * 1024 * 1024)
	}

	maxBytes := int64(maxDownloadSizeMB * 1024 * 1024)
	if sizeBytes > maxBytes {
		sizeBytes = maxBytes
	}
	if sizeBytes < 1 {
		sizeBytes = 1
	}

	chunkBytes := int64(defaultChunkBytes)
	if raw := r.URL.Query().Get("chunk"); raw != "" {
		if parsed, ok := parsePositiveInt64(raw); ok {
			chunkBytes = parsed
		} else {
			http.Error(w, "invalid chunk", http.StatusBadRequest)
			return
		}
	}
	if chunkBytes > maxChunkBytes {
		chunkBytes = maxChunkBytes
	}
	if chunkBytes < defaultChunkBytes {
		chunkBytes = defaultChunkBytes
	}
	release, ok := beginTransfer(w)
	if !ok {
		return
	}
	defer release()
	w.Header().Del("Connection")

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(sizeBytes, 10))
	w.Header().Set("Cache-Control", "no-store, no-transform")

	remaining := sizeBytes
	for remaining > 0 {
		logicalChunk := chunkBytes
		if remaining < logicalChunk {
			logicalChunk = remaining
		}
		if !writePayloadChunk(w, r, logicalChunk) {
			return
		}
		remaining -= logicalChunk
	}
}

func writePayloadChunk(w http.ResponseWriter, r *http.Request, sizeBytes int64) bool {
	remaining := sizeBytes
	for remaining > 0 {
		if r.Context().Err() != nil {
			return false
		}
		writeBytes := len(downloadPayload)
		if remaining < int64(writeBytes) {
			writeBytes = int(remaining)
		}
		if n, err := w.Write(downloadPayload[:writeBytes]); err != nil || n != writeBytes {
			return false
		}
		remaining -= int64(writeBytes)
	}
	return true
}

// UploadHandler drains the request body to benchmark upstream throughput.
func UploadHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Connection", "close")
	if r.Method != http.MethodPost && r.Method != http.MethodPut {
		w.Header().Set("Allow", "POST, PUT")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	maxBytes := int64(maxUploadSizeMB * 1024 * 1024)
	if r.ContentLength > maxBytes {
		w.Header().Set("Connection", "close")
		http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
		return
	}
	release, ok := beginTransfer(w)
	if !ok {
		return
	}
	defer release()
	w.Header().Del("Connection")
	reader := http.MaxBytesReader(w, r.Body, maxBytes)
	defer reader.Close()

	received, err := io.Copy(io.Discard, reader)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
			return
		}
		var timeout net.Error
		if errors.As(err, &timeout) && timeout.Timeout() {
			http.Error(w, "upload timed out", http.StatusRequestTimeout)
			return
		}
		http.Error(w, "failed to read payload", http.StatusBadRequest)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(uploadResponse{ReceivedBytes: received})
}

// PingHandler returns a lightweight JSON response for latency measurements.
func PingHandler(w http.ResponseWriter, r *http.Request) {
	// Ping never consumes request bodies, including unexpected GET bodies.
	if r.ContentLength != 0 {
		w.Header().Set("Connection", "close")
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store, no-cache")
	json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}
