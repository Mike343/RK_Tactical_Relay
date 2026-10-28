package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"time"
)

type dashboardPlayer struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Address   string `json:"address"`
	Aircraft  string `json:"aircraft"`
	Source    uint32 `json:"source"`
	Age       int64  `json:"state_age_ms"`
	Connected string `json:"connected"`
}
type dashboardStats struct {
	Version         string            `json:"version"`
	Network         string            `json:"network"`
	Protocol        uint32            `json:"protocol"`
	Players         int               `json:"players"`
	Peers           int               `json:"peers"`
	RemoteConfirmed bool              `json:"remote_confirmed"`
	UptimeSec       int64             `json:"uptime_seconds"`
	MemoryMiB       float64           `json:"memory_mib"`
	Goroutines      int               `json:"goroutines"`
	LoadNote        string            `json:"load_note"`
	ServerLocal     string            `json:"server_local"`
	ServerLAN       string            `json:"server_lan"`
	ServerInternet  string            `json:"server_internet"`
	Counters        totals            `json:"counters"`
	Clients         []dashboardPlayer `json:"clients"`
	Logs            []string          `json:"logs"`
}

func (s *relayServer) stats() dashboardStats {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	s.mu.RLock()
	out := dashboardStats{
		Version: versionLabel, Network: globalNetwork, Protocol: protocol, Players: len(s.clients), Peers: len(s.peers), RemoteConfirmed: s.remotelyConfirmed,
		UptimeSec: int64(time.Since(s.started).Seconds()), MemoryMiB: float64(m.Alloc) / 1024 / 1024, Goroutines: runtime.NumGoroutine(),
		LoadNote:    "Goroutines and Go heap shown; no CPU utilization sampling",
		ServerLocal: fmt.Sprintf("relay_url=ws://127.0.0.1:%d", s.cfg.Port),
		Counters:    s.counts.load(), Clients: make([]dashboardPlayer, 0, len(s.clients)), Logs: append([]string(nil), s.logLines[max(0, len(s.logLines)-maxLogLines):]...),
	}
	if s.lanIP != "" {
		out.ServerLAN = fmt.Sprintf("relay_url=ws://%s:%d", s.lanIP, s.cfg.Port)
	}
	if s.publicIP != "" {
		out.ServerInternet = fmt.Sprintf("relay_url=ws://%s:%d", s.publicIP, s.cfg.Port)
	}
	for _, c := range s.clients {
		p := dashboardPlayer{ID: c.ID, Name: c.Name, Address: c.IP, Source: panelContactID(c.ID), Connected: c.Joined.UTC().Format(time.RFC3339)}
		if c.State != nil {
			p.Aircraft = c.State.Aircraft
			p.Age = time.Since(c.LastState).Milliseconds()
		} else {
			p.Age = -1
		}
		out.Clients = append(out.Clients, p)
	}
	s.mu.RUnlock()
	sort.Slice(out.Clients, func(i, j int) bool { return out.Clients[i].Name < out.Clients[j].Name })
	return out
}
func privateDashboard(w http.ResponseWriter, r *http.Request) bool {
	if !dashboardAllowed(r) {
		http.NotFound(w, r)
		return false
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	return true
}
func (s *relayServer) statsHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.OpenDashboard || !privateDashboard(w, r) {
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(s.stats())
}
func (s *relayServer) dashboardHandler(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.OpenDashboard || !privateDashboard(w, r) {
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'nonce-RKSourceDash'; style-src 'nonce-RKSourceDash'; connect-src 'self'")
	_, _ = w.Write([]byte(dashboardHTML))
}

const dashboardHTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RK Tactical Relay</title>
<style nonce="RKSourceDash">
:root{color-scheme:dark;font-family:Segoe UI,Arial,sans-serif;color:#e9eef6;background:#101822}
body{margin:0 auto;max-width:1120px;padding:24px}h1{margin:0 0 3px;font-size:26px}.muted{color:#91a6b8}.top{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;margin-bottom:20px}
.panel{border:1px solid #334253;border-radius:9px;background:#192533;padding:16px;margin:13px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}
.value{font-weight:700;font-size:23px}.small{font-size:12px;color:#aac2d4}pre{overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;max-height:240px}
code{word-break:break-all;color:#b6d8ff}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #334253}th{color:#aac2d4}
.light{display:inline-block;width:18px;height:18px;border-radius:50%;background:#3c4957;box-shadow:inset 0 0 3px #000;vertical-align:middle;margin-right:8px}
.light.on{background:#37df71;box-shadow:0 0 12px #30c965;border:1px solid #91ffb3}.state{font-weight:bold}
</style></head><body>
<div class="top"><div><h1>RK Tactical Relay</h1><div class="muted">Protocol 3 · Standalone Go server</div></div>
<div><span id="light" class="light"></span><span id="status" class="state">NO CLIENTS CONNECTED</span></div></div>
<div class="grid">
<div class="panel"><div class="small">CONNECTED PILOTS</div><div id="players" class="value">0</div></div>
<div class="panel"><div class="small">INTERNET STATUS</div><div id="remote" class="value" style="font-size:16px">AWAITING REMOTE CONNECTION</div></div>
<div class="panel"><div class="small">COMBAT EVENTS</div><div id="combat" class="value">0</div></div>
<div class="panel"><div class="small">SERVER UPTIME</div><div id="uptime" class="value">0s</div></div>
</div>
<div class="panel"><h3>Companion relay_url configuration</h3><p class="small">Copy only the correct address for each client. Internet access requires port forwarding on TCP 8787.</p>
<div>Same computer: <code id="local"></code></div><div>LAN: <code id="lan"></code></div><div>Internet: <code id="internet"></code></div></div>
<div class="panel"><h3>Connected pilots</h3><table><thead><tr><th>Pilot</th><th>Aircraft</th><th>Client address</th><th>Connected</th></tr></thead><tbody id="pilotrows"></tbody></table></div>
<div class="panel"><h3>Traffic and runtime</h3><div id="traffic" class="small"></div></div>
<div class="panel"><h3>Recent activity</h3><pre id="logs"></pre></div>
<p class="muted small">Dashboard and /api/stats are restricted to connections from the server PC. For remote administration, use a private SSH tunnel or VPN. This dashboard has no remote password-based login.</p>
<script nonce="RKSourceDash">
const byId=id=>document.getElementById(id);
function put(id,value){byId(id).textContent=String(value ?? '');}
async function refresh(){
 try{
 const res=await fetch('/api/stats',{cache:'no-store'});if(!res.ok)throw Error('stats unavailable');const d=await res.json();
 put('players',d.players);put('status',d.players>0?'CLIENT CONNECTED':'NO CLIENTS CONNECTED');byId('light').classList.toggle('on',d.players>0);
 put('remote',d.remote_confirmed?'REMOTE CONNECTION CONFIRMED':'AWAITING REMOTE CONNECTION');
 put('combat',d.counters.Combat);put('uptime',d.uptime_seconds+'s');
 put('local',d.server_local);put('lan',d.server_lan||'not detected');put('internet',d.server_internet||'not detected');
 const c=d.counters;put('traffic','Received '+c.BytesIn+' bytes | Sent '+c.BytesOut+' bytes | Snapshots '+c.Snapshot+' | Combat relays '+c.CombatDelivered+' | Rejected combat events '+c.CombatRejected+' | Peers '+d.peers+' | Go heap '+d.memory_mib.toFixed(1)+' MiB | Goroutines '+d.goroutines);
 const tb=byId('pilotrows');tb.replaceChildren();for(const p of d.clients){const row=document.createElement('tr');for(const text of [p.name,p.aircraft||'(awaiting aircraft state)',p.address,p.connected]){const col=document.createElement('td');col.textContent=text;row.appendChild(col)}tb.appendChild(row)}
 put('logs',d.logs.slice(-55).join('\n'));
 }catch(e){put('status','DASHBOARD DISCONNECTED');byId('light').classList.remove('on')}
}
refresh();setInterval(refresh,1500);
</script></body></html>`
