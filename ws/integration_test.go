package ws

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
	"golang.org/x/net/websocket"
)

// These tests change process-wide configuration and must not run in parallel.
func configureLocalICE(t *testing.T) string {
	t.Helper()
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			t.Fatal(err)
		}
		for _, addr := range addrs {
			ip, _, err := net.ParseCIDR(addr.String())
			if err != nil || ip.To4() == nil || !ip.IsGlobalUnicast() || ip.IsLoopback() {
				continue
			}
			oldIP, oldMin, oldMax := connManager.config()
			t.Cleanup(func() {
				SetPublicIP(oldIP)
				SetUDPPortRange(oldMin, oldMax)
			})
			SetPublicIP(ip.String())
			// A broad unprivileged range avoids reserving/releasing a single racy port.
			SetUDPPortRange(32768, 60999)
			return ip.String()
		}
	}
	t.Skip("local ICE integration requires an up, non-loopback IPv4 interface")
	return ""
}

func TestWebSocketHandlerIntegration(t *testing.T) {
	localIP := configureLocalICE(t)
	connManager.mutex.RLock()
	initialConnections := len(connManager.connections)
	connManager.mutex.RUnlock()
	if initialConnections != 0 {
		t.Fatalf("unexpected existing connections: %d", initialConnections)
	}

	handlerDone := make(chan struct{})
	server := httptest.NewServer(websocket.Handler(func(ws *websocket.Conn) {
		defer close(handlerDone)
		WebSocketHandler(ws)
	}))
	t.Cleanup(server.Close)
	signal, err := websocket.Dial("ws"+strings.TrimPrefix(server.URL, "http"), "", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		signal.Close()
		select {
		case <-handlerDone:
		case <-time.After(5 * time.Second):
			t.Error("WebSocket handler did not release its resources")
		}
	})
	if err := signal.SetDeadline(time.Now().Add(15 * time.Second)); err != nil {
		t.Fatal(err)
	}

	settings := webrtc.SettingEngine{}
	settings.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settings.SetIPFilter(func(ip net.IP) bool { return ip.String() == localIP })
	client, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close() })
	ordered, retransmits := false, uint16(0)
	dc, err := client.CreateDataChannel("echo", &webrtc.DataChannelInit{
		Ordered: &ordered, MaxRetransmits: &retransmits,
	})
	if err != nil {
		t.Fatal(err)
	}
	opened := make(chan struct{})
	messages := make(chan webrtc.DataChannelMessage, 16)
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(msg webrtc.DataChannelMessage) { messages <- msg })
	offer, err := client.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(client)
	if err := client.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		t.Fatal("local ICE gathering timed out")
	}
	if err := websocket.JSON.Send(signal, client.LocalDescription()); err != nil {
		t.Fatal(err)
	}

	// The server trickles candidates, which can arrive before its SDP answer.
	signalingDone := make(chan error, 1)
	readerDone := make(chan struct{})
	t.Cleanup(func() {
		signal.Close()
		select {
		case <-readerDone:
		case <-time.After(5 * time.Second):
			t.Error("signaling reader did not exit")
		}
	})
	go func() {
		defer close(readerDone)
		signalingDone <- func() error {
			var pending []webrtc.ICECandidateInit
			for {
				var payload string
				if err := websocket.Message.Receive(signal, &payload); err != nil {
					return err
				}
				var msg struct {
					Type string `json:"type"`
					SDP  string `json:"sdp"`
					webrtc.ICECandidateInit
				}
				if err := json.Unmarshal([]byte(payload), &msg); err != nil {
					return err
				}
				if msg.Type == "answer" {
					if err := client.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: msg.SDP}); err != nil {
						return err
					}
				} else if msg.Candidate != "" {
					pending = append(pending, msg.ICECandidateInit)
				} else {
					return fmt.Errorf("unexpected signaling message: %s", payload)
				}
				if client.RemoteDescription() != nil {
					for _, candidate := range pending {
						if err := client.AddICECandidate(candidate); err != nil {
							return err
						}
					}
					pending = nil
				}
			}
		}()
	}()
	select {
	case <-opened:
	case err := <-signalingDone:
		t.Fatalf("signaling ended before channel opened: %v", err)
	case <-time.After(10 * time.Second):
		t.Fatal("data channel did not open")
	}

	connManager.mutex.RLock()
	var serverPC *webrtc.PeerConnection
	var connectionID string
	for id, pc := range connManager.connections {
		connectionID, serverPC = id, pc
	}
	count := len(connManager.connections)
	connManager.mutex.RUnlock()
	if count != 1 {
		t.Fatalf("registered connections = %d, want 1", count)
	}
	if servers := serverPC.GetConfiguration().ICEServers; len(servers) != 0 {
		t.Fatalf("integration test must not use STUN/TURN: %+v", servers)
	}
	if !strings.Contains(client.RemoteDescription().SDP, "a=max-message-size:16384\r\n") {
		t.Fatal("server did not advertise the 16 KiB SCTP message limit")
	}
	for _, size := range []int{0, 3, 16*1024 - 1, 16 * 1024} {
		for _, text := range []bool{true, false} {
			t.Run(fmt.Sprintf("size=%d/text=%t", size, text), func(t *testing.T) {
				payload := bytes.Repeat([]byte("x"), size)
				if !text {
					for i := range payload {
						payload[i] = byte(i)
					}
				}
				var err error
				if text {
					err = dc.SendText(string(payload))
				} else {
					err = dc.Send(payload)
				}
				if err != nil {
					t.Fatal(err)
				}
				select {
				case msg := <-messages:
					if msg.IsString != text || !bytes.Equal(msg.Data, payload) {
						t.Fatalf("echo changed payload/type: size=%d text=%t", len(msg.Data), msg.IsString)
					}
				case err := <-signalingDone:
					t.Fatalf("signaling ended during echo: %v", err)
				case <-time.After(5 * time.Second):
					t.Fatal("echo timed out")
				}
			})
		}
	}
	t.Run("above negotiated limit", func(t *testing.T) {
		payload := make([]byte, 16*1024+1)
		if err := dc.Send(payload); err == nil {
			t.Error("binary send accepted a message above the negotiated limit")
		}
		if err := dc.SendText(string(payload)); err == nil {
			t.Error("text send accepted a message above the negotiated limit")
		}
	})

	// Do not close the client WS: Closed must unblock the handler's Receive.
	peerClosed := make(chan error, 1)
	go func() { peerClosed <- client.Close() }()
	select {
	case err := <-peerClosed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PeerConnection.Close deadlocked")
	}
	select {
	case err := <-signalingDone:
		if err != io.EOF {
			t.Fatalf("expected server-initiated WS close, got %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("PeerConnection close left signaling open")
	}
	select {
	case <-handlerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("PeerConnection close left handler running")
	}
	if _, exists := connManager.GetConnection(connectionID); exists {
		t.Fatal("closed peer remains registered")
	}
	if serverPC.ConnectionState() != webrtc.PeerConnectionStateClosed {
		t.Fatal("server peer is not closed")
	}
}
