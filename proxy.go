package main

import (
	"net"
	"net/http"
	"strings"
)

func (c config) clientIP(r *http.Request) string {
	peer := remoteIP(r.RemoteAddr)
	peerIP := net.ParseIP(peer)
	if !c.TrustProxy || peerIP == nil || !inNets(peerIP, c.TrustedProxies) {
		return peer
	}
	if forwarded := r.Header.Get("X-Forwarded-For"); forwarded != "" {
		hops := strings.Split(forwarded, ",")
		for i := len(hops) - 1; i >= 0; i-- {
			ip := net.ParseIP(strings.TrimSpace(hops[i]))
			if ip == nil {
				return peer
			}
			if !inNets(ip, c.TrustedProxies) || i == 0 {
				return ip.String()
			}
		}
	}
	if ip := net.ParseIP(strings.TrimSpace(r.Header.Get("X-Real-Ip"))); ip != nil {
		return ip.String()
	}
	return peer
}
