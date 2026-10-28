package main

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
	"time"
)

type publicPilot struct {
	Name     string  `json:"name"`
	Aircraft string  `json:"aircraft"`
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	AltFt    int     `json:"alt_ft"`
	Heading  int     `json:"heading"`
	SpeedKts int     `json:"speed_kts"`
	Online   int64   `json:"online_seconds"`
}

type publicInfo struct {
	Version  string        `json:"version"`
	Network  string        `json:"network"`
	Protocol uint32        `json:"protocol"`
	Online   int           `json:"online"`
	Replicas int           `json:"replicas"`
	Uptime   int64         `json:"uptime_seconds"`
	Pilots   []publicPilot `json:"pilots"`
}

func roundTo(v float64, places int) float64 {
	p := math.Pow(10, float64(places))
	return math.Round(v*p) / p
}

func (s *relayServer) publicInfo(now time.Time) publicInfo {
	s.mu.RLock()
	out := publicInfo{
		Version: versionLabel, Network: globalNetwork, Protocol: protocol,
		Replicas: len(s.peers) + 1, Uptime: int64(now.Sub(s.started).Seconds()),
		Pilots: make([]publicPilot, 0, len(s.clients)+len(s.remote)),
	}
	add := func(name string, st aircraftState, joined time.Time) {
		out.Pilots = append(out.Pilots, publicPilot{
			Name: name, Aircraft: st.Aircraft,
			Lat: roundTo(st.Lat, 2), Lon: roundTo(st.Lon, 2),
			AltFt: int(math.Round(st.AltFt/100) * 100), Heading: int(math.Round(st.Heading)), SpeedKts: int(math.Round(st.SpeedKts)),
			Online: max(0, int64(now.Sub(joined).Seconds())),
		})
	}
	for _, c := range s.clients {
		if c.State != nil && now.Sub(c.LastState) <= stateExpiry {
			add(c.Name, *c.State, c.Joined)
		}
	}
	for _, rc := range s.remote {
		if now.Sub(rc.seen) <= stateExpiry {
			add(rc.name, rc.state, rc.joined)
		}
	}
	s.mu.RUnlock()
	sort.Slice(out.Pilots, func(i, j int) bool {
		if out.Pilots[i].Online != out.Pilots[j].Online {
			return out.Pilots[i].Online > out.Pilots[j].Online
		}
		return out.Pilots[i].Name < out.Pilots[j].Name
	})
	if len(out.Pilots) > maxPlayers {
		out.Pilots = out.Pilots[:maxPlayers]
	}
	out.Online = len(out.Pilots)
	return out
}

func (s *relayServer) publicHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.PublicAPI || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=2")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_ = json.NewEncoder(w).Encode(s.publicInfo(time.Now()))
}
