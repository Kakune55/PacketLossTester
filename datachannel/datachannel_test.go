package datachannel

import (
	"bytes"
	"errors"
	"fmt"
	"testing"

	"github.com/pion/webrtc/v4"
)

type fakeEchoChannel struct {
	buffered uint64
	sent     []byte
	text     bool
	calls    int
	err      error
}

func (d *fakeEchoChannel) BufferedAmount() uint64 { return d.buffered }
func (d *fakeEchoChannel) Send(b []byte) error {
	d.calls++
	d.sent = b
	return d.err
}
func (d *fakeEchoChannel) SendText(s string) error {
	d.text = true
	return d.Send([]byte(s))
}

func TestEcho(t *testing.T) {
	for _, size := range []int{0, 3, 16*1024 - 1, 16 * 1024} {
		for _, text := range []bool{true, false} {
			t.Run(fmt.Sprintf("size=%d/text=%t", size, text), func(t *testing.T) {
				payload := bytes.Repeat([]byte("x"), size)
				d := &fakeEchoChannel{buffered: MaxEchoBufferedAmount - uint64(size)}
				if err := Echo(d, webrtc.DataChannelMessage{Data: payload, IsString: text}); err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(d.sent, payload) || d.text != text || d.calls != 1 {
					t.Fatalf("echo changed payload/type: size=%d text=%t calls=%d", len(d.sent), d.text, d.calls)
				}
			})
		}
	}
}

func TestEchoOverload(t *testing.T) {
	for _, buffered := range []uint64{MaxEchoBufferedAmount - 2, MaxEchoBufferedAmount, MaxEchoBufferedAmount + 1, ^uint64(0)} {
		d := &fakeEchoChannel{buffered: buffered}
		if err := Echo(d, webrtc.DataChannelMessage{Data: []byte("abc")}); !errors.Is(err, ErrEchoOverloaded) {
			t.Fatalf("buffered %d: got %v", buffered, err)
		}
		if d.calls != 0 {
			t.Fatal("sent data despite overload")
		}
	}
	d := &fakeEchoChannel{}
	if err := Echo(d, webrtc.DataChannelMessage{Data: make([]byte, MaxEchoBufferedAmount+1)}); !errors.Is(err, ErrEchoOverloaded) {
		t.Fatalf("oversized message: %v", err)
	}
}

func TestEchoSendError(t *testing.T) {
	want := errors.New("send failed")
	d := &fakeEchoChannel{err: want}
	if err := Echo(d, webrtc.DataChannelMessage{}); !errors.Is(err, want) {
		t.Fatalf("got %v, want %v", err, want)
	}
}

func TestInvalidSignal(t *testing.T) {
	for _, msg := range []string{"{", "{}", `{"type":"unknown","sdp":"bad"}`} {
		if err := HandleSignal(nil, msg, nil); err == nil {
			t.Fatalf("accepted %q", msg)
		}
	}
}
