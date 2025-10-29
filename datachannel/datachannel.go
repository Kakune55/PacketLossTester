package datachannel

import (
	"encoding/json"
	"fmt"
	"log"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

// InitializePeerConnection 初始化并返回一个新的 WebRTC PeerConnection
func InitializePeerConnection() (*webrtc.PeerConnection, error) {
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302", "stun:stun01.sipphone.com"},
			},
		},
	}

	peerConnection, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}
	return peerConnection, nil
}

// HandleICECandidate 处理 ICE 候选
func HandleICECandidate(peerConnection *webrtc.PeerConnection, ws *websocket.Conn) {
	peerConnection.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		candidate := c.ToJSON()
		candidateJSON, err := json.Marshal(candidate)
		if err != nil {
			log.Println("Failed to marshal ICE candidate:", err)
			return
		}
		if err := websocket.Message.Send(ws, string(candidateJSON)); err != nil {
			log.Println("Failed to send ICE candidate:", err)
		}
	})
}

// HandleSDP 处理 SDP 消息
func HandleSDP(peerConnection *webrtc.PeerConnection, msg string, ws *websocket.Conn) error {
	var sdp webrtc.SessionDescription
	if err := json.Unmarshal([]byte(msg), &sdp); err != nil {
		return fmt.Errorf("failed to unmarshal SDP: %w", err)
	}

	switch sdp.Type {
case webrtc.SDPTypeOffer:
		if err := peerConnection.SetRemoteDescription(sdp); err != nil {
			return fmt.Errorf("failed to set remote description: %w", err)
		}

		answer, err := peerConnection.CreateAnswer(nil)
		if err != nil {
			return fmt.Errorf("failed to create answer: %w", err)
		}

		if err := peerConnection.SetLocalDescription(answer); err != nil {
			return fmt.Errorf("failed to set local description: %w", err)
		}

		answerJSON, err := json.Marshal(answer)
		if err != nil {
			return fmt.Errorf("failed to marshal answer: %w", err)
		}
		if err := websocket.Message.Send(ws, string(answerJSON)); err != nil {
			return fmt.Errorf("failed to send answer: %w", err)
		}
	case webrtc.SDPTypeAnswer:
		if err := peerConnection.SetRemoteDescription(sdp); err != nil {
			return fmt.Errorf("failed to set remote description: %w", err)
		}
	}
	return nil
}
