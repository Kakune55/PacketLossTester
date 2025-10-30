package datachannel

import (
	"encoding/json"
	"fmt"
	"log"
	"os"

	"github.com/pion/ice/v2"
	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

// InitializePeerConnection 初始化并返回一个新的 WebRTC PeerConnection
func InitializePeerConnection() (*webrtc.PeerConnection, error) {
	return InitializePeerConnectionWithPublicIP("")
}

// InitializePeerConnectionWithPublicIP 使用指定的公网IP初始化 WebRTC PeerConnection
func InitializePeerConnectionWithPublicIP(publicIP string) (*webrtc.PeerConnection, error) {
	return InitializePeerConnectionWithConfig(publicIP, 0, 0)
}

// InitializePeerConnectionWithConfig 使用完整配置初始化 WebRTC PeerConnection
func InitializePeerConnectionWithConfig(publicIP string, udpPortMin, udpPortMax uint16) (*webrtc.PeerConnection, error) {
	// 创建 SettingEngine 以配置 NAT 类型
	settingEngine := webrtc.SettingEngine{}
	
	// 如果提供了公网IP或设置了环境变量，则配置 NAT 1to1 映射
	if publicIP == "" {
		publicIP = os.Getenv("PUBLIC_IP")
	}
	
	if publicIP != "" {
		log.Printf("Using public IP for NAT 1:1 mapping: %s", publicIP)
		settingEngine.SetNAT1To1IPs([]string{publicIP}, webrtc.ICECandidateTypeHost)
	} else {
		log.Println("No public IP configured, using default NAT traversal")
	}
	
	// 配置UDP端口范围
	if udpPortMin > 0 && udpPortMax > 0 && udpPortMax >= udpPortMin {
		log.Printf("Setting UDP port range: %d-%d", udpPortMin, udpPortMax)
		if err := settingEngine.SetEphemeralUDPPortRange(udpPortMin, udpPortMax); err != nil {
			log.Printf("Warning: Failed to set UDP port range: %v", err)
		}
		// 禁用 mDNS 以避免 .local 候选
		settingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	} else {
		log.Println("Using random UDP ports (no range specified)")
	}
	
	// 设置网络类型，允许所有类型的候选
	settingEngine.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeUDP6,
		webrtc.NetworkTypeTCP4,
		webrtc.NetworkTypeTCP6,
	})

	// 如果配置了公网IP和端口范围，则不需要STUN服务器
	var config webrtc.Configuration
	if publicIP != "" && udpPortMin > 0 && udpPortMax > 0 {
		// 有公网IP和端口范围，不使用STUN
		log.Println("Using direct connection without STUN (public IP configured)")
		config = webrtc.Configuration{
			ICEServers:           []webrtc.ICEServer{}, // 不使用STUN
			ICECandidatePoolSize: 10,
		}
	} else {
		// 没有公网IP配置，使用STUN服务器
		log.Println("Using STUN servers for NAT traversal")
		config = webrtc.Configuration{
			ICEServers: []webrtc.ICEServer{
				{
					URLs: []string{
						"stun:stun.l.google.com:19302",
						"stun:stun1.l.google.com:19302",
						"stun:stun2.l.google.com:19302",
						"stun:stun.sipgate.net:3478",
					},
				},
			},
			ICECandidatePoolSize: 10,
		}
	}

	// 使用 API 创建 PeerConnection
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))
	peerConnection, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, fmt.Errorf("failed to create peer connection: %w", err)
	}
	
	log.Println("PeerConnection initialized with NAT configuration")
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
