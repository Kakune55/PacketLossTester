package ws

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

func rawClient(t *testing.T, handler websocket.Handler) (net.Conn, *bufio.Reader) {
	t.Helper()
	s := httptest.NewServer(handler)
	t.Cleanup(s.Close)
	c, err := net.Dial("tcp", strings.TrimPrefix(s.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	req, _ := http.NewRequest("GET", s.URL, nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Origin", s.URL)
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	if err := req.Write(c); err != nil {
		t.Fatal(err)
	}
	r := bufio.NewReader(c)
	resp, err := http.ReadResponse(r, req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("upgrade: %s", resp.Status)
	}
	return c, r
}

func readFrame(t *testing.T, r *bufio.Reader) (byte, []byte) {
	t.Helper()
	var h [2]byte
	if _, err := io.ReadFull(r, h[:]); err != nil {
		t.Fatal(err)
	}
	length := int(h[1])
	if length == 126 {
		var extended [2]byte
		if _, err := io.ReadFull(r, extended[:]); err != nil {
			t.Fatal(err)
		}
		length = int(binary.BigEndian.Uint16(extended[:]))
	} else if length > 126 {
		t.Fatalf("unexpected frame header: %x", h)
	}
	b := make([]byte, length)
	if _, err := io.ReadFull(r, b); err != nil {
		t.Fatal(err)
	}
	return h[0] & 15, b
}

func sendFrame(t *testing.T, c net.Conn, opcode byte, b []byte) {
	t.Helper()
	if len(b) > 65535 {
		t.Fatal("test frame too large")
	}
	frame := []byte{0x80 | opcode, 0x80 | byte(len(b))}
	if len(b) >= 126 {
		frame = []byte{0x80 | opcode, 0xfe, byte(len(b) >> 8), byte(len(b))}
	}
	frame = append(frame, 0, 0, 0, 0)
	frame = append(frame, b...)
	if _, err := c.Write(frame); err != nil {
		t.Fatal(err)
	}
}

func TestNativePingKeepsIdleSignalingOpen(t *testing.T) {
	done := make(chan error, 1)
	c, r := rawClient(t, func(ws *websocket.Conn) {
		defer ws.Close()
		stop := keepAlive(ws, 5*time.Millisecond)
		defer stop()
		var msg string
		err := websocket.Message.Receive(ws, &msg)
		if err == nil && msg != "still alive" {
			t.Errorf("unexpected message %q", msg)
		}
		done <- err
	})
	// Exercise many idle heartbeat intervals while Receive remains blocked.
	for i := 0; i < 12; i++ {
		opcode, payload := readFrame(t, r)
		if opcode != websocket.PingFrame {
			t.Fatalf("opcode = %d", opcode)
		}
		sendFrame(t, c, websocket.PongFrame, payload)
	}
	sendFrame(t, c, websocket.TextFrame, []byte("still alive"))
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Receive did not survive idle heartbeats")
	}
}

func TestHandlerCloseCodes(t *testing.T) {
	for _, tc := range []struct {
		name      string
		oversized bool
		code      uint16
	}{
		{"invalid signal", false, closePolicyViolation},
		{"oversized frame header", true, closeMessageTooBig},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, r := rawClient(t, WebSocketHandler)
			if tc.oversized {
				// Only send the header, proving rejection occurs before payload allocation/read.
				h := []byte{0x81, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}
				binary.BigEndian.PutUint64(h[2:10], maxSignalBytes+1)
				if _, err := c.Write(h); err != nil {
					t.Fatal(err)
				}
			} else {
				sendFrame(t, c, websocket.TextFrame, []byte("{}"))
			}
			opcode, payload := readFrame(t, r)
			if opcode != websocket.CloseFrame || len(payload) != 2 || binary.BigEndian.Uint16(payload) != tc.code {
				t.Fatalf("close frame: opcode=%d payload=%x", opcode, payload)
			}
		})
	}
}

func TestUnregisterConnection(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	cm := &ConnectionManager{connections: map[string]*webrtc.PeerConnection{"test": pc}}
	cm.unregisterConnection("test")
	if _, ok := cm.GetConnection("test"); ok {
		t.Fatal("connection not removed")
	}
	if pc.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatal("peer not closed")
	}
	cm.unregisterConnection("test")
}

func TestDataChannelLimit(t *testing.T) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	for i := 0; i < maxDataChannels+1; i++ {
		if _, err := pc.CreateDataChannel("test", nil); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("ICE gathering timed out")
	}
	c, r := rawClient(t, WebSocketHandler)
	b, err := json.Marshal(pc.LocalDescription())
	if err != nil {
		t.Fatal(err)
	}
	sendFrame(t, c, websocket.TextFrame, b)
	var pending []webrtc.ICECandidateInit
	for {
		opcode, payload := readFrame(t, r)
		if opcode == websocket.CloseFrame {
			if len(payload) != 2 || binary.BigEndian.Uint16(payload) != closePolicyViolation {
				t.Fatalf("unexpected close: %x", payload)
			}
			return
		}
		if opcode == websocket.PingFrame {
			sendFrame(t, c, websocket.PongFrame, payload)
			continue
		}
		var msg struct {
			Type string `json:"type"`
			SDP  string `json:"sdp"`
			webrtc.ICECandidateInit
		}
		if err := json.Unmarshal(payload, &msg); err != nil {
			t.Fatal(err)
		}
		if msg.Type == "answer" {
			if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: msg.SDP}); err != nil {
				t.Fatal(err)
			}
			for _, candidate := range pending {
				if err := pc.AddICECandidate(candidate); err != nil {
					t.Fatal(err)
				}
			}
			pending = nil
		} else if pc.RemoteDescription() == nil {
			pending = append(pending, msg.ICECandidateInit)
		} else if err := pc.AddICECandidate(msg.ICECandidateInit); err != nil {
			t.Fatal(err)
		}
	}
}
