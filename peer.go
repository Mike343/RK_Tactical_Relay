package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

const (
	peerMaxMessage = 4 * 1024 * 1024
	peerIdle       = 20 * time.Second
	peerTick       = 100 * time.Millisecond
	peerPingEvery  = 50
)

type remoteContact struct {
	contact
	pod  string
	seen time.Time
}

type peerLink struct {
	*outbox
	pod      string
	lastSent time.Time
}

type peerState struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Aircraft string   `json:"aircraft"`
	Lat      float64  `json:"lat"`
	Lon      float64  `json:"lon"`
	AltFt    float64  `json:"altFt"`
	Heading  float64  `json:"heading"`
	SpeedKts float64  `json:"speedKts"`
	Joined   int64    `json:"joined"`
	Team     uint32   `json:"team,omitempty"`
	Detected []uint32 `json:"detected,omitempty"`
}

type peerEnvelope struct {
	T       string          `json:"t"`
	ID      string          `json:"id,omitempty"`
	States  []peerState     `json:"states,omitempty"`
	Combat  *combatMessage  `json:"combat,omitempty"`
	Session *sessionRecord  `json:"session,omitempty"`
	History []sessionRecord `json:"history,omitempty"`
}

func (s *relayServer) peerCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.peers)
}

func (s *relayServer) broadcastPeers(env peerEnvelope) {
	links := s.snapshotLinks()
	if len(links) == 0 {
		return
	}
	b, _ := json.Marshal(env)
	for _, l := range links {
		l.enqueue(wsText, b)
	}
}

func (s *relayServer) forwardCombat(m combatMessage) {
	s.broadcastPeers(peerEnvelope{T: "combat", Combat: &m})
}

func (s *relayServer) addPeer(ws *webSocket, pod string) *peerLink {
	l := &peerLink{outbox: newOutbox(ws, &s.counts), pod: pod}
	s.mu.Lock()
	old := s.peers[pod]
	s.peers[pod] = l
	s.mu.Unlock()
	if old != nil {
		old.ws.close()
	}
	go l.run(s.addBytesOut)
	history := s.historySnapshot()
	for start := 0; start < len(history); start += historyChunk {
		end := min(start+historyChunk, len(history))
		b, _ := json.Marshal(peerEnvelope{T: "history", History: history[start:end]})
		l.enqueue(wsText, b)
	}
	s.logEvent("PEER_UP pod=%s", pod)
	return l
}

func (s *relayServer) removePeer(l *peerLink) {
	l.ws.close()
	s.mu.Lock()
	if s.peers[l.pod] != l {
		s.mu.Unlock()
		return
	}
	delete(s.peers, l.pod)
	for id, rc := range s.remote {
		if rc.pod == l.pod {
			delete(s.remote, id)
		}
	}
	s.mu.Unlock()
	s.logEvent("PEER_DOWN pod=%s", l.pod)
	s.requestBroadcast()
}

func (s *relayServer) runPeer(l *peerLink) {
	defer s.removePeer(l)
	_ = l.ws.conn.SetReadDeadline(time.Now().Add(peerIdle))
	for {
		op, data, err := l.ws.readMessage(func() {
			_ = l.ws.conn.SetReadDeadline(time.Now().Add(peerIdle))
		})
		if err != nil {
			return
		}
		_ = l.ws.conn.SetReadDeadline(time.Now().Add(peerIdle))
		if op != wsText {
			return
		}
		var env peerEnvelope
		if json.Unmarshal(data, &env) != nil {
			return
		}
		s.handlePeer(l, env)
	}
}

func (s *relayServer) handlePeer(l *peerLink, env peerEnvelope) {
	switch env.T {
	case "states":
		now := time.Now()
		s.mu.Lock()
		for _, p := range env.States {
			if len(p.ID) == 0 || len(p.ID) > 64 || !allIDCharacters(p.ID) || len(s.remote) >= maxPlayers*8 {
				continue
			}
			if !num(p.Lat).inRange(-90, 90) || !num(p.Lon).inRange(-180, 180) || !num(p.AltFt).inRange(-2000, 200000) || !num(p.SpeedKts).inRange(0, 10000) {
				continue
			}
			s.remote[p.ID] = remoteContact{
				contact: contact{id: p.ID, hash: hashID(p.ID), name: cleanText(p.Name, 40), joined: time.Unix(0, p.Joined), state: aircraftState{Lat: p.Lat, Lon: p.Lon, AltFt: p.AltFt, Heading: p.Heading, SpeedKts: p.SpeedKts, Aircraft: cleanText(p.Aircraft, 80)}, team: min(p.Team, 2), detected: p.Detected[:min(len(p.Detected), 32)], panel: panelContactID(p.ID)},
				pod:     l.pod,
				seen:    now,
			}
		}
		s.mu.Unlock()
	case "join":
		var stale []*relayClient
		s.mu.Lock()
		delete(s.remote, env.ID)
		for _, c := range s.clients {
			if c.ID == env.ID {
				stale = append(stale, c)
			}
		}
		s.mu.Unlock()
		for _, c := range stale {
			c.WS.closeWith(4001, "identity reconnected")
			s.logEvent("REPLACED name=%q id=%s address=%s reason=identity_connected_on_peer", c.Name, c.ID, c.IP)
		}
	case "session":
		if env.Session != nil {
			s.mergeHistory([]sessionRecord{*env.Session})
		}
	case "history":
		s.mergeHistory(env.History)
	case "leave":
		s.mu.Lock()
		if rc, ok := s.remote[env.ID]; ok && rc.pod == l.pod {
			delete(s.remote, env.ID)
		}
		s.mu.Unlock()
		s.requestBroadcast()
	case "combat":
		m := env.Combat
		if m == nil || m.Event == 0 || m.Event > 9 || m.Weapon == 0 || m.Weapon > 5 {
			return
		}
		m.Type = "combat"
		delivered := s.deliverCombat(*m, nil)
		s.counts.CombatDelivered.Add(uint64(delivered))
	}
}

func (s *relayServer) syncPeers(now time.Time) {
	s.mu.Lock()
	for id, rc := range s.remote {
		if now.Sub(rc.seen) > stateExpiry {
			delete(s.remote, id)
		}
	}
	if len(s.peers) == 0 {
		s.mu.Unlock()
		return
	}
	links := s.linksLocked()
	type localState struct {
		peerState
		at time.Time
	}
	var states []localState
	for _, c := range s.clients {
		if c.State == nil || now.Sub(c.LastState) > stateExpiry {
			continue
		}
		states = append(states, localState{peerState{c.ID, c.Name, c.State.Aircraft, c.State.Lat, c.State.Lon, c.State.AltFt, c.State.Heading, c.State.SpeedKts, c.Joined.UnixNano(), c.Team, c.Detected}, c.LastState})
	}
	s.mu.Unlock()
	encoded := make(map[time.Time][]byte)
	for _, l := range links {
		b, seen := encoded[l.lastSent]
		if !seen {
			var batch []peerState
			for _, st := range states {
				if st.at.After(l.lastSent) {
					batch = append(batch, st.peerState)
				}
			}
			if len(batch) > 0 {
				b, _ = json.Marshal(peerEnvelope{T: "states", States: batch})
			}
			encoded[l.lastSent] = b
		}
		l.lastSent = now
		if b != nil {
			l.enqueue(wsText, b)
		}
	}
}

func (s *relayServer) pingPeers() {
	links := s.snapshotLinks()
	for _, l := range links {
		l.enqueue(wsPing, nil)
	}
}

func (s *relayServer) peerLoop(ctx context.Context) {
	t := time.NewTicker(peerTick)
	defer t.Stop()
	ticks := 0
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-t.C:
			s.syncPeers(now)
			ticks++
			if ticks%peerPingEvery == 0 {
				s.pingPeers()
			}
		}
	}
}

func (s *relayServer) ownIP() string {
	if s.cfg.PodIP != "" {
		return s.cfg.PodIP
	}
	return s.lanIP
}

func (s *relayServer) dialLoop(ctx context.Context) {
	for {
		s.dialPeers(ctx)
		select {
		case <-ctx.Done():
			return
		case <-time.After(5 * time.Second):
		}
	}
}

func (s *relayServer) dialPeers(ctx context.Context) {
	ips, err := net.DefaultResolver.LookupHost(ctx, s.cfg.PeerDNS)
	if err != nil {
		return
	}
	own := s.ownIP()
	for _, ip := range ips {
		if ip == own || ip > own {
			continue
		}
		s.mu.Lock()
		busy := s.dialing[ip]
		s.dialing[ip] = true
		s.mu.Unlock()
		if busy {
			continue
		}
		go func(ip string) {
			defer func() {
				s.mu.Lock()
				delete(s.dialing, ip)
				s.mu.Unlock()
			}()
			s.connectPeer(ip)
		}(ip)
	}
}

func (s *relayServer) connectPeer(ip string) {
	addr := net.JoinHostPort(ip, strconv.Itoa(s.cfg.PeerPort))
	header := http.Header{"Authorization": {"Bearer " + s.cfg.PeerToken}}
	ws, err := dialWS(addr, "/peer?pod="+url.QueryEscape(s.podID), header, 3*time.Second)
	if err != nil {
		return
	}
	_ = ws.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	op, data, err := ws.readMessage(func() {})
	var hello peerEnvelope
	if err != nil || op != wsText || json.Unmarshal(data, &hello) != nil || hello.T != "hello" || hello.ID == "" || hello.ID == s.podID {
		ws.close()
		return
	}
	l := s.addPeer(ws, hello.ID)
	s.runPeer(l)
}

func (s *relayServer) peerHandler(w http.ResponseWriter, r *http.Request) {
	want := "Bearer " + s.cfg.PeerToken
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(want)) != 1 {
		http.NotFound(w, r)
		return
	}
	pod := r.URL.Query().Get("pod")
	if pod == "" || pod == s.podID {
		http.Error(w, "invalid pod", http.StatusBadRequest)
		return
	}
	ws, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	ws.limit = peerMaxMessage
	hello, _ := json.Marshal(peerEnvelope{T: "hello", ID: s.podID})
	if ws.writeFrame(wsText, hello) != nil {
		ws.close()
		return
	}
	l := s.addPeer(ws, pod)
	s.runPeer(l)
}

func (s *relayServer) peerRoutes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/peer", s.peerHandler)
	return mux
}

func (s *relayServer) linksLocked() []*peerLink {
	links := make([]*peerLink, 0, len(s.peers))
	for _, l := range s.peers {
		links = append(links, l)
	}
	return links
}

func (s *relayServer) snapshotLinks() []*peerLink {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.linksLocked()
}
