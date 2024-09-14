package datachannel

import (
	"encoding/json"
	"log"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

var peerConnection *webrtc.PeerConnection

// InitializePeerConnection 初始化并返回一个新的 WebRTC PeerConnection
func InitializePeerConnection() *webrtc.PeerConnection {
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: []string{"stun:stun.l.google.com:19302", "stun:stun01.sipphone.com"},
			},
		},
	}

	var err error
	peerConnection, err = webrtc.NewPeerConnection(config)
	if err != nil {
		log.Fatal(err)
	}
	return peerConnection
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
func HandleSDP(peerConnection *webrtc.PeerConnection, msg string, ws *websocket.Conn) {
	var sdp webrtc.SessionDescription
	if err := json.Unmarshal([]byte(msg), &sdp); err != nil {
		log.Println("Failed to unmarshal SDP:", err)
		return
	}

	if sdp.Type == webrtc.SDPTypeOffer {
		if err := peerConnection.SetRemoteDescription(sdp); err != nil {
			log.Println("Failed to set remote description:", err)
			return
		}

		answer, err := peerConnection.CreateAnswer(nil)
		if err != nil {
			log.Println("Failed to create answer:", err)
			return
		}

		if err := peerConnection.SetLocalDescription(answer); err != nil {
			log.Println("Failed to set local description:", err)
			return
		}

		answerJSON, _ := json.Marshal(answer)
		if err := websocket.Message.Send(ws, string(answerJSON)); err != nil {
			log.Println("Failed to send answer:", err)
		}
	} else if sdp.Type == webrtc.SDPTypeAnswer {
		if err := peerConnection.SetRemoteDescription(sdp); err != nil {
			log.Println("Failed to set remote description:", err)
		}
	}
}
