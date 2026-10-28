package main

import (
	"context"
	"net/http"
	"runtime/debug"
	"time"
)

const (
	clientIdle   = 30 * time.Second
	peerWarmup   = 8 * time.Second
	restartDelay = time.Second
)

func (s *relayServer) safely(name string, fn func()) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			s.logEvent("PANIC in %s: %v\n%s", name, r, debug.Stack())
			ok = false
		}
	}()
	fn()
	return true
}

func (s *relayServer) supervise(ctx context.Context, name string, fn func()) {
	go func() {
		for !s.safely(name, fn) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(restartDelay):
			}
		}
	}()
}

func (s *relayServer) acquireIP(ip string) bool {
	if s.cfg.MaxConnsPerIP <= 0 {
		return true
	}
	s.ipMu.Lock()
	defer s.ipMu.Unlock()
	if s.ipConns == nil {
		s.ipConns = make(map[string]int)
	}
	if s.ipConns[ip] >= s.cfg.MaxConnsPerIP {
		return false
	}
	s.ipConns[ip]++
	return true
}

func (s *relayServer) releaseIP(ip string) {
	if s.cfg.MaxConnsPerIP <= 0 {
		return
	}
	s.ipMu.Lock()
	defer s.ipMu.Unlock()
	if s.ipConns[ip] <= 1 {
		delete(s.ipConns, ip)
		return
	}
	s.ipConns[ip]--
}

func (s *relayServer) isReady() bool {
	if s.draining.Load() {
		return false
	}
	return !s.cfg.peeringEnabled() || time.Since(s.started) >= peerWarmup
}

func (s *relayServer) readyHandler(w http.ResponseWriter, r *http.Request) {
	if !s.isReady() {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	s.healthHandler(w, r)
}

func (s *relayServer) drain(ctx context.Context) {
	s.draining.Store(true)
	if s.cfg.DrainSeconds <= 0 {
		return
	}
	s.logEvent("DRAIN waiting %ds before closing clients", s.cfg.DrainSeconds)
	select {
	case <-time.After(time.Duration(s.cfg.DrainSeconds) * time.Second):
	case <-ctx.Done():
	}
}
