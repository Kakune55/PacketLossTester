package ws

import (
	"log"

	"pltester/datachannel"

	"github.com/pion/webrtc/v3"
	"golang.org/x/net/websocket"
)

// WebSocketHandler 处理 WebSocket 连接
func WebSocketHandler(ws *websocket.Conn) {
	defer ws.Close()

	peerConnection := datachannel.InitializePeerConnection()
	datachannel.HandleICECandidate(peerConnection, ws)

	peerConnection.OnDataChannel(func(d *webrtc.DataChannel) {
		d.OnOpen(func() {
			log.Println("Data channel opened")
		})
		d.OnMessage(func(msg webrtc.DataChannelMessage) {
			if err := d.SendText(string(msg.Data)); err != nil {
				log.Println("Failed to send message:", err)
			}
		})
	})

	for {
		var msg string
		if err := websocket.Message.Receive(ws, &msg); err != nil {
			log.Println("Can't receive:", err)
			break
		}
		datachannel.HandleSDP(peerConnection, msg, ws)
	}
}
