package nodes

import (
	"encoding/json"
	"net/http"

	"pltester/config"
)

// Handler serves the configured catalog without probing or registering nodes.
func Handler(catalog []config.Node) http.HandlerFunc {
	if len(catalog) == 0 {
		catalog = config.DefaultNodes()
	}
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			r.Close = true
			w.Header().Set("Connection", "close")
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		json.NewEncoder(w).Encode(struct {
			Nodes []config.Node `json:"nodes"`
		}{Nodes: catalog})
	}
}
