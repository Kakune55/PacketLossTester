package speedtest

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
)

const (
	defaultDownloadSizeMB = 10.0
	maxDownloadSizeMB     = 1024.0
	maxUploadSizeMB       = 1024.0
	defaultChunkBytes     = 64 * 1024
	maxChunkBytes         = 100 * 1024 * 1024
)

var downloadPayload = newDownloadPayload(defaultChunkBytes)

type uploadResponse struct {
	ReceivedBytes int64 `json:"receivedBytes"`
}

func newDownloadPayload(size int) []byte {
	buf := make([]byte, size)
	for i := range buf {
		buf[i] = byte((i*31 + 17) & 0xff)
	}
	return buf
}

func parsePositiveInt64(raw string) (int64, bool) {
	parsed, err := strconv.ParseInt(raw, 10, 64)
	return parsed, err == nil && parsed > 0
}

// DownloadHandler streams a reusable payload to benchmark downstream throughput.
func DownloadHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	sizeBytes := int64(defaultDownloadSizeMB * 1024 * 1024)
	if raw := r.URL.Query().Get("bytes"); raw != "" {
		if parsed, ok := parsePositiveInt64(raw); ok {
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

	chunkBytes := int64(defaultChunkBytes)
	if raw := r.URL.Query().Get("chunk"); raw != "" {
		if parsed, ok := parsePositiveInt64(raw); ok {
			chunkBytes = parsed
		}
	}
	if chunkBytes > maxChunkBytes {
		chunkBytes = maxChunkBytes
	}
	if chunkBytes < 1 {
		chunkBytes = 1
	}

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", strconv.FormatInt(sizeBytes, 10))
	w.Header().Set("Cache-Control", "no-store")

	flusher, _ := w.(http.Flusher)
	remaining := sizeBytes
	for remaining > 0 {
		logicalChunk := chunkBytes
		if remaining < logicalChunk {
			logicalChunk = remaining
		}
		if !writePayloadChunk(w, logicalChunk) {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		remaining -= logicalChunk
	}
}

func writePayloadChunk(w http.ResponseWriter, sizeBytes int64) bool {
	remaining := sizeBytes
	for remaining > 0 {
		writeBytes := len(downloadPayload)
		if remaining < int64(writeBytes) {
			writeBytes = int(remaining)
		}
		if _, err := w.Write(downloadPayload[:writeBytes]); err != nil {
			return false
		}
		remaining -= int64(writeBytes)
	}
	return true
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
