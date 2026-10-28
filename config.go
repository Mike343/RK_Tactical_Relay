package main

import (
	"net"
	"os"
	"strconv"
	"strings"
)

const defaultTrustedProxies = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,127.0.0.0/8,::1/128"

type config struct {
	Port           int
	OpenDashboard  bool
	PublicIPLookup bool
	PublicAPI      bool
	TrustProxy     bool
	TrustedProxies []*net.IPNet
	PeerDNS        string
	PeerPort       int
	PeerToken      string
	PodName        string
	PodIP          string
	MaxConnsPerIP  int
	DrainSeconds   int
}

func defaultConfig() config {
	return config{Port: 8787, OpenDashboard: true, PublicIPLookup: true, TrustedProxies: parseCIDRs(defaultTrustedProxies), PeerPort: 8788, MaxConnsPerIP: 64}
}

func parseBool(v string) bool {
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes")
}

func parsePort(v string) (int, bool) {
	n, err := strconv.Atoi(v)
	return n, err == nil && n > 0 && n < 65536
}

func parseCIDRs(list string) []*net.IPNet {
	var nets []*net.IPNet
	for _, part := range strings.Split(list, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if !strings.Contains(part, "/") {
			if ip := net.ParseIP(part); ip != nil {
				bits := 128
				if ip.To4() != nil {
					bits = 32
				}
				part += "/" + strconv.Itoa(bits)
			}
		}
		if _, n, err := net.ParseCIDR(part); err == nil {
			nets = append(nets, n)
		}
	}
	return nets
}

func readINI(path string) config {
	cfg := defaultConfig()
	b, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	section := ""
	for _, line := range strings.Split(string(b), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(line[1 : len(line)-1])
			continue
		}
		if section != "relay" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.ToLower(strings.TrimSpace(k))
		v = strings.TrimSpace(strings.SplitN(strings.SplitN(v, ";", 2)[0], "#", 2)[0])
		switch k {
		case "port":
			if n, ok := parsePort(v); ok {
				cfg.Port = n
			}
		case "open_dashboard":
			cfg.OpenDashboard = parseBool(v)
		case "public_ip_lookup":
			cfg.PublicIPLookup = parseBool(v)
		case "public_api":
			cfg.PublicAPI = parseBool(v)
		case "trust_proxy":
			cfg.TrustProxy = parseBool(v)
		case "trusted_proxies":
			cfg.TrustedProxies = parseCIDRs(v)
		case "peer_dns":
			cfg.PeerDNS = v
		case "peer_port":
			if n, ok := parsePort(v); ok {
				cfg.PeerPort = n
			}
		case "peer_token":
			cfg.PeerToken = v
		case "max_conns_per_ip":
			if n, err := strconv.Atoi(v); err == nil && n >= 0 {
				cfg.MaxConnsPerIP = n
			}
		case "drain_seconds":
			if n, err := strconv.Atoi(v); err == nil && n >= 0 && n <= 120 {
				cfg.DrainSeconds = n
			}
		}
	}
	return cfg
}

func applyEnv(cfg config) config {
	if n, ok := parsePort(os.Getenv("PORT")); ok {
		cfg.Port = n
	}
	if v := os.Getenv("OPEN_DASHBOARD"); v != "" {
		cfg.OpenDashboard = parseBool(v)
	}
	if v := os.Getenv("PUBLIC_IP_LOOKUP"); v != "" {
		cfg.PublicIPLookup = parseBool(v)
	}
	if v := os.Getenv("PUBLIC_API"); v != "" {
		cfg.PublicAPI = parseBool(v)
	}
	if v := os.Getenv("TRUST_PROXY"); v != "" {
		cfg.TrustProxy = parseBool(v)
	}
	if v := os.Getenv("TRUSTED_PROXIES"); v != "" {
		cfg.TrustedProxies = parseCIDRs(v)
	}
	if v := os.Getenv("PEER_DNS"); v != "" {
		cfg.PeerDNS = v
	}
	if n, ok := parsePort(os.Getenv("PEER_PORT")); ok {
		cfg.PeerPort = n
	}
	if v := os.Getenv("PEER_TOKEN"); v != "" {
		cfg.PeerToken = v
	}
	if n, err := strconv.Atoi(os.Getenv("MAX_CONNS_PER_IP")); err == nil && n >= 0 {
		cfg.MaxConnsPerIP = n
	}
	if n, err := strconv.Atoi(os.Getenv("DRAIN_SECONDS")); err == nil && n >= 0 && n <= 120 {
		cfg.DrainSeconds = n
	}
	cfg.PodName = os.Getenv("POD_NAME")
	cfg.PodIP = os.Getenv("POD_IP")
	return cfg
}

func (c config) peeringEnabled() bool {
	return c.PeerDNS != "" && c.PeerToken != ""
}

func inNets(ip net.IP, nets []*net.IPNet) bool {
	for _, n := range nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
