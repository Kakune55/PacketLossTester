package ipinfo

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	defaultIPAPIBaseURL = "http://ip-api.com/json/"
	ipAPILang           = "zh-CN"
	ipAPIFields         = "status,message,country,countryCode,region,regionName,city,lat,lon,isp,org,as,asname,query,timezone"
	defaultTimeout      = 8 * time.Second
)

// Entry represents enriched IP information returned to the frontend.
type Entry struct {
	Success   bool    `json:"success"`
	IP        string  `json:"ip"`
	Country   string  `json:"country"`
	Region    string  `json:"region"`
	City      string  `json:"city"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
	ISP       string  `json:"isp"`
	Org       string  `json:"org"`
	AS        string  `json:"as"`
	ASName    string  `json:"asName"`
	Timezone  string  `json:"timezone"`
	Message   string  `json:"message,omitempty"`
	Source    string  `json:"source,omitempty"`
}

// Response bundles user and server information for the API response.
type Response struct {
	User      Entry     `json:"user"`
	Server    Entry     `json:"server"`
	Timestamp time.Time `json:"timestamp"`
}

type lookupOptions struct {
	allowSelf bool
	allowDNS  bool
}

// Service encapsulates lookup logic and caching for server metadata.
type Service struct {
	httpClient *http.Client
	serverHint string
	apiBaseURL string

	mu              sync.RWMutex
	cachedServer    Entry
	serverExpiresAt time.Time
}

// NewService constructs an IP info service.
func NewService(serverIPHint string, customAPIHost string) *Service {
	client := &http.Client{Timeout: defaultTimeout}
	baseURL := strings.TrimSpace(customAPIHost)
	if baseURL == "" {
		baseURL = defaultIPAPIBaseURL
	}
	if !strings.HasSuffix(baseURL, "/") {
		baseURL += "/"
	}
	return &Service{
		httpClient: client,
		serverHint: strings.TrimSpace(serverIPHint),
		apiBaseURL: baseURL,
	}
}

// Handler exposes an http.HandlerFunc that returns IP metadata in JSON form.
func (s *Service) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		userOverride := strings.TrimSpace(r.URL.Query().Get("user"))

		var userEntry Entry
		if userOverride != "" {
			userEntry = s.lookup(ctx, userOverride, lookupOptions{allowSelf: true, allowDNS: true})
			if userEntry.IP == "" {
				userEntry.IP = userOverride
			}
			if userEntry.Success && userEntry.Source == "" {
				userEntry.Source = "客户端提供"
			}
		} else {
			userIP := ExtractClientIP(r)
			userEntry = s.lookup(ctx, userIP, lookupOptions{allowSelf: false, allowDNS: false})
			if userEntry.IP == "" {
				userEntry.IP = userIP
			}
			if userEntry.Success && userEntry.Source == "" {
				userEntry.Source = "请求来源"
			}
		}
		serverEntry := s.serverEntry(ctx)

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(Response{
			User:      userEntry,
			Server:    serverEntry,
			Timestamp: time.Now().UTC(),
		})
	}
}

// ExtractClientIP attempts to derive the visitor IP from common proxy headers.
func ExtractClientIP(r *http.Request) string {
	candidates := []string{}

	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		for _, part := range strings.Split(xff, ",") {
			if trimmed := strings.TrimSpace(part); trimmed != "" {
				candidates = append(candidates, trimmed)
			}
		}
	}

	headerNames := []string{
		"CF-Connecting-IP",
		"True-Client-IP",
		"X-Real-IP",
		"X-Client-IP",
		"X-Forwarded",
	}

	for _, name := range headerNames {
		if v := strings.TrimSpace(r.Header.Get(name)); v != "" {
			candidates = append(candidates, v)
		}
	}

	if host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr)); err == nil {
		candidates = append(candidates, host)
	} else if r.RemoteAddr != "" {
		candidates = append(candidates, strings.TrimSpace(r.RemoteAddr))
	}

	for _, candidate := range candidates {
		if ip := normalizeIP(candidate); ip != "" {
			return ip
		}
	}
	return ""
}

type ipAPIResponse struct {
	Status   string  `json:"status"`
	Message  string  `json:"message"`
	Country  string  `json:"country"`
	Region   string  `json:"regionName"`
	City     string  `json:"city"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	ISP      string  `json:"isp"`
	Org      string  `json:"org"`
	AS       string  `json:"as"`
	ASName   string  `json:"asname"`
	Query    string  `json:"query"`
	Timezone string  `json:"timezone"`
}

func (s *Service) serverEntry(ctx context.Context) Entry {
	s.mu.RLock()
	cached := s.cachedServer
	expires := s.serverExpiresAt
	s.mu.RUnlock()

	if time.Now().Before(expires) {
		return cached
	}

	entry := s.lookup(ctx, s.serverHint, lookupOptions{allowSelf: true, allowDNS: true})
	if !entry.Success {
		// Allow automatic public IP detection when hint is missing or private.
		if entry.Message == "局域网或保留地址" || s.serverHint == "" {
			fallback := s.lookup(ctx, "", lookupOptions{allowSelf: true})
			if fallback.Success {
				entry = fallback
			} else if entry.IP == "" {
				entry.IP = fallback.IP
			}
		}
	}

	if entry.IP == "" {
		entry.IP = s.serverHint
	}

	ttl := time.Minute
	if entry.Success {
		ttl = 15 * time.Minute
	}

	s.mu.Lock()
	s.cachedServer = entry
	s.serverExpiresAt = time.Now().Add(ttl)
	s.mu.Unlock()
	return entry
}

func (s *Service) lookup(ctx context.Context, ip string, opts lookupOptions) Entry {
	ip = strings.TrimSpace(ip)
	entry := Entry{IP: ip}

	var target string
	var parsed net.IP

	switch {
	case ip == "":
		if !opts.allowSelf {
			entry.Message = "未提供 IP"
			return entry
		}
		target = ""
	default:
		cleaned := stripZone(ip)
		if parsedIP := net.ParseIP(cleaned); parsedIP != nil {
			parsed = parsedIP
			target = parsedIP.String()
		} else if opts.allowDNS {
			if resolved, err := resolveHost(cleaned); err == nil && resolved != nil {
				parsed = resolved
				target = resolved.String()
			} else {
				entry.Message = "无效 IP 地址"
				return entry
			}
		} else {
			entry.Message = "无效 IP 地址"
			return entry
		}
	}

	if parsed != nil && !isLikelyPublicIP(parsed) {
		entry.Message = "局域网或保留地址"
		return entry
	}

	requestURL := s.apiBaseURL
	if target != "" {
		entry.IP = target
		requestURL = requestURL + url.PathEscape(target)
	}

	query := url.Values{}
	query.Set("fields", ipAPIFields)
	query.Set("lang", ipAPILang)
	if strings.Contains(requestURL, "?") {
		requestURL = requestURL + "&" + query.Encode()
	} else {
		requestURL = requestURL + "?" + query.Encode()
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		entry.Message = err.Error()
		return entry
	}

	resp, err := s.httpClient.Do(req)
	if err != nil {
		entry.Message = err.Error()
		return entry
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		entry.Message = fmt.Sprintf("IP情报服务错误（HTTP %d）", resp.StatusCode)
		return entry
	}

	var api ipAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&api); err != nil {
		entry.Message = fmt.Sprintf("解析响应失败: %v", err)
		return entry
	}

	if !strings.EqualFold(api.Status, "success") {
		entry.Message = safeMessage(api.Message)
		if api.Query != "" && entry.IP == "" {
			entry.IP = api.Query
		}
		return entry
	}

	entry.Success = true
	entry.Country = api.Country
	entry.Region = api.Region
	entry.City = api.City
	entry.Latitude = api.Lat
	entry.Longitude = api.Lon
	entry.ISP = api.ISP
	entry.Org = api.Org
	entry.AS = api.AS
	entry.ASName = api.ASName
	entry.Timezone = api.Timezone
	entry.Source = "ip-api.com"
	if api.Query != "" {
		entry.IP = api.Query
	}
	return entry
}

func safeMessage(msg string) string {
	if strings.TrimSpace(msg) == "" {
		return "未能获取属地信息"
	}
	return msg
}

func resolveHost(host string) (net.IP, error) {
	host = strings.TrimSpace(host)
	if host == "" {
		return nil, errors.New("empty host")
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		if err == nil {
			err = errors.New("no ip records")
		}
		return nil, err
	}
	for _, ip := range ips {
		if isLikelyPublicIP(ip) {
			return ip, nil
		}
	}
	return ips[0], nil
}

func normalizeIP(candidate string) string {
	candidate = strings.TrimSpace(candidate)
	if candidate == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(candidate); err == nil {
		candidate = host
	}
	candidate = stripZone(candidate)
	if ip := net.ParseIP(candidate); ip != nil {
		return ip.String()
	}
	return ""
}

func stripZone(value string) string {
	if idx := strings.Index(value, "%"); idx >= 0 {
		return value[:idx]
	}
	return value
}

func isLikelyPublicIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if !ip.IsGlobalUnicast() {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return false
	}
	return true
}
