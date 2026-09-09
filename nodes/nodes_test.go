package nodes

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"pltester/config"
)

func TestHandler(t *testing.T) {
	custom := []config.Node{
		{ID: "local", Name: "本机节点", Capabilities: []string{"packetloss", "speedtest"}},
		{ID: "east-1", Name: "East", Region: "US", BaseURL: "https://example.com/prefix", Capabilities: []string{"speedtest"}},
	}
	for _, tt := range []struct {
		name    string
		catalog []config.Node
		want    []config.Node
	}{
		{"nil", nil, config.DefaultNodes()},
		{"empty", []config.Node{}, config.DefaultNodes()},
		{"custom", custom, custom},
	} {
		t.Run(tt.name, func(t *testing.T) {
			mux := http.NewServeMux()
			mux.HandleFunc("/api/nodes", Handler(tt.catalog))
			recorder := httptest.NewRecorder()
			mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/nodes", nil))
			if recorder.Code != http.StatusOK || recorder.Header().Get("Content-Type") != "application/json" {
				t.Fatalf("unexpected response: %d %v", recorder.Code, recorder.Header())
			}
			var body struct {
				Nodes []config.Node `json:"nodes"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(body.Nodes, tt.want) {
				t.Fatalf("nodes = %+v, want %+v", body.Nodes, tt.want)
			}
			var raw map[string][]map[string]json.RawMessage
			if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
				t.Fatal(err)
			}
			if len(raw) != 1 || string(raw["nodes"][0]["baseUrl"]) != `""` || raw["nodes"][0]["region"] != nil {
				t.Fatalf("unexpected JSON contract: %s", recorder.Body.String())
			}
		})
	}
}

func TestHandlerMethods(t *testing.T) {
	for _, method := range []string{http.MethodHead, http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch, http.MethodOptions} {
		t.Run(method, func(t *testing.T) {
			w := httptest.NewRecorder()
			Handler(nil).ServeHTTP(w, httptest.NewRequest(method, "/api/nodes", nil))
			if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != http.MethodGet {
				t.Fatalf("unexpected response: %d %v", w.Code, w.Header())
			}
		})
	}
}
