package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"
)

const (
	versionLabel         = "1.4.0-source-reconstruction"
	globalNetwork        = "rk-tactical-global"
	maxPlayers           = 1024
	stateExpiry          = 10 * time.Second
	magic         uint32 = 0x31504d52
	protocol      uint32 = 3
	snapshotSize         = 3864
	contactSize          = 120
	maxContacts          = 32
)

type config struct {
	Port           int
	OpenDashboard  bool
	PublicIPLookup bool
}

func defaultConfig() config { return config{8787, true, true} }

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
			if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
				cfg.Port = n
			}
		case "open_dashboard":
			cfg.OpenDashboard = (v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes"))
		case "public_ip_lookup":
			cfg.PublicIPLookup = (v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "yes"))
		}
	}
	return cfg
}

type aircraftState struct {
	Lat, Lon, AltFt, Heading, SpeedKts float64
	Aircraft                           string
}
type relayClient struct {
	ID, Name, IP           string
	WS                     *webSocket
	State                  *aircraftState
	LastState, LastMessage time.Time
	Pong                   atomic.Bool
	Joined                 time.Time
}
type totals struct {
	Connects, Disconnects, State, Combat, CombatRejected, CombatDelivered, Snapshot, BytesIn, BytesOut uint64
	ByEvent                                                                                            [7]uint64
}
type relayServer struct {
	mu                sync.RWMutex
	clients           map[*webSocket]*relayClient
	sequence          uint32
	cfg               config
	started           time.Time
	counts            totals
	logLines          []string
	lanIP, publicIP   string
	remotelyConfirmed bool
}

func newRelay(cfg config) *relayServer {
	return &relayServer{clients: make(map[*webSocket]*relayClient), cfg: cfg, started: time.Now(), lanIP: detectLAN()}
}
func cleanText(s string, limit int) string {
	var b strings.Builder
	for _, r := range s {
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
		if utf8.RuneCountInString(b.String()) >= limit {
			break
		}
	}
	return b.String()
}
func hashID(s string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(s))
	v := h.Sum32()
	if v == 0 {
		return 1
	}
	return v
}
func panelContactID(s string) uint32     { return 0x60000000 | (hashID(s) & 0x0fffffff) }
func normalizeHeading(v float64) float64 { return math.Mod(math.Mod(v, 360)+360, 360) }
func inRange(v *float64, lo, hi float64) bool {
	return v != nil && !math.IsNaN(*v) && !math.IsInf(*v, 0) && *v >= lo && *v <= hi
}
func validUnsigned(v *uint32, upper uint32) bool { return v != nil && *v <= upper }
func (s *relayServer) logEvent(format string, args ...any) {
	msg := fmt.Sprintf("[%s] %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	log.Print(msg)
	s.mu.Lock()
	s.logLines = append(s.logLines, msg)
	if len(s.logLines) > 180 {
		s.logLines = append([]string(nil), s.logLines[len(s.logLines)-180:]...)
	}
	s.mu.Unlock()
}
func remoteIP(address string) string {
	h, _, err := net.SplitHostPort(address)
	if err == nil {
		return h
	}
	return address
}
func isPrivateIP(s string) bool {
	ip := net.ParseIP(strings.Trim(s, "[]"))
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
}
func dashboardAllowed(r *http.Request) bool {
	return net.ParseIP(remoteIP(r.RemoteAddr)) != nil && net.ParseIP(remoteIP(r.RemoteAddr)).IsLoopback()
}
func distanceKey(viewer *relayClient, other *relayClient) float64 {
	if viewer == nil || viewer.State == nil {
		return 0
	}
	latRad := viewer.State.Lat * math.Pi / 180
	dlat := other.State.Lat - viewer.State.Lat
	delta := other.State.Lon - viewer.State.Lon
	dlon := (math.Mod(delta+540, 360) + 360)
	dlon = math.Mod(dlon, 360) - 180
	dlon *= math.Cos(latRad)
	return dlat*dlat + dlon*dlon
}
func putText(buf []byte, src string) {
	n := len(buf) - 1
	if n < 1 {
		return
	}
	b := []byte(src)
	if len(b) < n {
		n = len(b)
	}
	copy(buf[:n], b[:n])
}
func (s *relayServer) snapshotFor(viewer *relayClient) []byte {
	s.mu.RLock()
	now := time.Now()
	if viewer != nil {
		viewerCopy := &relayClient{ID: viewer.ID}
		if viewer.State != nil {
			stateCopy := *viewer.State
			viewerCopy.State = &stateCopy
		}
		viewer = viewerCopy
	}
	candidates := make([]*relayClient, 0, len(s.clients))
	for _, c := range s.clients {
		if (viewer == nil || c.ID != viewer.ID) && c.State != nil && now.Sub(c.LastState) <= stateExpiry {
			stateCopy := *c.State
			candidates = append(candidates, &relayClient{ID: c.ID, Name: c.Name, State: &stateCopy, Joined: c.Joined})
		}
	}
	s.mu.RUnlock()
	sort.SliceStable(candidates, func(i, j int) bool {
		di, dj := distanceKey(viewer, candidates[i]), distanceKey(viewer, candidates[j])
		if di == dj {
			return candidates[i].Joined.Before(candidates[j].Joined)
		}
		return di < dj
	})
	if len(candidates) > maxContacts {
		candidates = candidates[:maxContacts]
	}
	buf := make([]byte, snapshotSize)
	s.mu.Lock()
	s.sequence++
	if s.sequence == 0 {
		s.sequence = 1
	}
	seq := s.sequence
	s.counts.Snapshot++
	s.mu.Unlock()
	binary.LittleEndian.PutUint32(buf[0:4], magic)
	binary.LittleEndian.PutUint32(buf[4:8], protocol)
	binary.LittleEndian.PutUint32(buf[8:12], snapshotSize)
	binary.LittleEndian.PutUint32(buf[12:16], seq)
	binary.LittleEndian.PutUint32(buf[16:20], uint32(len(candidates)))
	for i, c := range candidates {
		o := 24 + i*contactSize
		binary.LittleEndian.PutUint32(buf[o:o+4], hashID(c.ID))
		binary.LittleEndian.PutUint64(buf[o+8:o+16], math.Float64bits(c.State.Lat))
		binary.LittleEndian.PutUint64(buf[o+16:o+24], math.Float64bits(c.State.Lon))
		binary.LittleEndian.PutUint64(buf[o+24:o+32], math.Float64bits(c.State.AltFt))
		binary.LittleEndian.PutUint32(buf[o+32:o+36], math.Float32bits(float32(c.State.Heading)))
		binary.LittleEndian.PutUint32(buf[o+36:o+40], math.Float32bits(float32(c.State.SpeedKts)))
		putText(buf[o+40:o+72], c.Name)
		putText(buf[o+72:o+120], c.State.Aircraft)
	}
	return buf
}
func (s *relayServer) snapshotBroadcast() {
	s.mu.RLock()
	clients := make([]*relayClient, 0, len(s.clients))
	for _, c := range s.clients {
		clients = append(clients, c)
	}
	s.mu.RUnlock()
	for _, c := range clients {
		data := s.snapshotFor(c)
		if err := c.WS.writeFrame(wsBinary, data); err != nil {
			c.WS.close()
			continue
		}
		s.mu.Lock()
		s.counts.BytesOut += uint64(len(data))
		s.mu.Unlock()
	}
}

type wireMessage struct {
	Type         string   `json:"type"`
	Protocol     *uint32  `json:"protocol"`
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Lat          *float64 `json:"lat"`
	Lon          *float64 `json:"lon"`
	AltFt        *float64 `json:"altFt"`
	Heading      *float64 `json:"heading"`
	SpeedKts     *float64 `json:"speedKts"`
	Aircraft     string   `json:"aircraft"`
	Event        *uint32  `json:"event"`
	Weapon       *uint32  `json:"weapon"`
	Target       *uint32  `json:"target"`
	WeaponID     *uint32  `json:"weaponId"`
	Flags        *uint32  `json:"flags"`
	Damage       *float64 `json:"damage"`
	Duration     *float64 `json:"duration"`
	MissDistance *float64 `json:"missDistance"`
}

func (s *relayServer) acceptHello(ws *webSocket, remote string, msg wireMessage) (*relayClient, bool) {
	if msg.Protocol == nil || *msg.Protocol != protocol {
		s.logEvent("REJECT address=%s reason=unsupported_protocol", remote)
		_ = ws.writeFrame(wsText, []byte(`{"type":"error","message":"unsupported protocol"}`))
		ws.closeWith(1002, "unsupported protocol")
		return nil, false
	}
	id := cleanText(msg.ID, 64)
	name := cleanText(msg.Name, 40)
	if name == "" {
		name = "RK Pilot"
	}
	if id == "" || len(id) > 64 || !allIDCharacters(id) {
		s.logEvent("REJECT address=%s reason=invalid_identity", remote)
		ws.closeWith(1008, "invalid identity")
		return nil, false
	}
	c := &relayClient{ID: id, Name: name, IP: remote, WS: ws, Joined: time.Now()}
	c.Pong.Store(true)
	var replaced []*relayClient
	s.mu.Lock()
	for oldWS, old := range s.clients {
		if old.ID == id {
			replaced = append(replaced, old)
			delete(s.clients, oldWS)
		}
	}
	if len(s.clients) >= maxPlayers {
		s.mu.Unlock()
		ws.closeWith(1013, "network full")
		return nil, false
	}
	s.clients[ws] = c
	s.counts.Connects++
	if !isPrivateIP(remote) {
		s.remotelyConfirmed = true
	}
	users := len(s.clients)
	s.mu.Unlock()
	for _, old := range replaced {
		old.WS.closeWith(4001, "identity reconnected")
		s.logEvent("REPLACED name=%q id=%s address=%s reason=identity_reconnected", old.Name, old.ID, old.IP)
	}
	s.logEvent("CONNECT name=%q id=%s address=%s users=%d", name, id, remote, users)
	welcome := struct {
		Type     string `json:"type"`
		Protocol uint32 `json:"protocol"`
		ID       string `json:"id"`
		Network  string `json:"network"`
	}{"welcome", protocol, id, globalNetwork}
	b, _ := json.Marshal(welcome)
	if err := ws.writeFrame(wsText, b); err != nil {
		s.mu.Lock()
		delete(s.clients, ws)
		s.mu.Unlock()
		ws.close()
		return nil, false
	}
	s.snapshotBroadcast()
	return c, true
}
func allIDCharacters(s string) bool {
	for _, r := range s {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '-' || r == '.') {
			return false
		}
	}
	return true
}
func (s *relayServer) acceptState(c *relayClient, m wireMessage) {
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	if now.Sub(c.LastMessage) < 100*time.Millisecond {
		return
	}
	c.LastMessage = now
	if !inRange(m.Lat, -90, 90) || !inRange(m.Lon, -180, 180) || !inRange(m.AltFt, -2000, 200000) || !inRange(m.Heading, -360, 720) || !inRange(m.SpeedKts, 0, 10000) {
		return
	}
	c.State = &aircraftState{Lat: *m.Lat, Lon: *m.Lon, AltFt: *m.AltFt, Heading: normalizeHeading(*m.Heading), SpeedKts: *m.SpeedKts, Aircraft: cleanText(m.Aircraft, 80)}
	c.LastState = now
	s.counts.State++
}
func combatName(v uint32) string {
	return []string{"NONE", "LAUNCH", "END", "HIT", "COUNTERMEASURE", "UPDATE", "EXPLOSION"}[v]
}
func weaponName(v uint32) string {
	return []string{"NONE", "AIM120", "AIM9", "TRACER", "CHAFF", "FLARE"}[v]
}
func (s *relayServer) acceptCombat(c *relayClient, m wireMessage) {
	valid := validUnsigned(m.Event, 6) && *m.Event > 0 && validUnsigned(m.Weapon, 5) && *m.Weapon > 0 && validUnsigned(m.Target, ^uint32(0)) && validUnsigned(m.WeaponID, ^uint32(0)) && validUnsigned(m.Flags, ^uint32(0)) && inRange(m.Lat, -90, 90) && inRange(m.Lon, -180, 180) && inRange(m.AltFt, -2000, 200000) && inRange(m.Heading, -360, 720) && inRange(m.Damage, 0, 1000) && inRange(m.Duration, 0, 300) && inRange(m.MissDistance, 0, 10000000)
	if !valid {
		s.mu.Lock()
		s.counts.CombatRejected++
		s.mu.Unlock()
		s.logEvent("COMBAT_REJECT name=%q id=%s reason=invalid_event", c.Name, c.ID)
		return
	}
	source := panelContactID(c.ID)
	type msg struct {
		Type         string  `json:"type"`
		Event        uint32  `json:"event"`
		Weapon       uint32  `json:"weapon"`
		Source       uint32  `json:"source"`
		Target       uint32  `json:"target"`
		WeaponID     uint32  `json:"weaponId"`
		Flags        uint32  `json:"flags"`
		Lat          float64 `json:"lat"`
		Lon          float64 `json:"lon"`
		AltFt        float64 `json:"altFt"`
		Heading      float64 `json:"heading"`
		Damage       float64 `json:"damage"`
		Duration     float64 `json:"duration"`
		MissDistance float64 `json:"missDistance"`
	}
	base := msg{"combat", *m.Event, *m.Weapon, source, *m.Target, *m.WeaponID, *m.Flags, *m.Lat, *m.Lon, *m.AltFt, normalizeHeading(*m.Heading), *m.Damage, *m.Duration, *m.MissDistance}
	s.mu.RLock()
	others := make([]*relayClient, 0, len(s.clients))
	for _, cl := range s.clients {
		if cl != c {
			others = append(others, cl)
		}
	}
	s.mu.RUnlock()
	delivered := 0
	for _, dest := range others {
		localTarget := panelContactID(dest.ID) == base.Target
		if base.Event == 3 && !localTarget {
			continue
		}
		copyMessage := base
		if localTarget {
			copyMessage.Flags |= 1
		}
		b, _ := json.Marshal(copyMessage)
		if err := dest.WS.writeFrame(wsText, b); err != nil {
			dest.WS.close()
			continue
		}
		delivered++
		s.mu.Lock()
		s.counts.BytesOut += uint64(len(b))
		s.mu.Unlock()
	}
	s.mu.Lock()
	s.counts.Combat++
	s.counts.CombatDelivered += uint64(delivered)
	s.counts.ByEvent[base.Event]++
	s.mu.Unlock()
	if base.Event != 5 {
		s.logEvent("COMBAT %s weapon=%s from=%q source=%d target=%d delivered=%d", combatName(base.Event), weaponName(base.Weapon), c.Name, source, base.Target, delivered)
	}
}
func (s *relayServer) wsHandler(w http.ResponseWriter, r *http.Request) {
	ws, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer ws.close()
	remote := remoteIP(r.RemoteAddr)
	var client *relayClient
	defer func() {
		if client == nil {
			return
		}
		s.mu.Lock()
		_, ok := s.clients[ws]
		if ok {
			delete(s.clients, ws)
			s.counts.Disconnects++
		}
		users := len(s.clients)
		s.mu.Unlock()
		if ok {
			s.logEvent("DISCONNECT name=%q id=%s address=%s users=%d", client.Name, client.ID, remote, users)
			s.snapshotBroadcast()
		}
	}()
	_ = ws.conn.SetReadDeadline(time.Now().Add(12 * time.Second)) // hello deadline
	for {
		opcode, data, err := ws.readMessage(func() {
			if client != nil {
				client.Pong.Store(true)
			}
		})
		if err != nil {
			if !errors.Is(err, io.EOF) {
				ws.closeWith(1002, "invalid frame")
			}
			return
		}
		if opcode != wsText {
			ws.closeWith(1003, "text only")
			return
		}
		var msg wireMessage
		if !json.Valid(data) || json.Unmarshal(data, &msg) != nil {
			ws.closeWith(1007, "invalid JSON")
			return
		}
		s.mu.Lock()
		s.counts.BytesIn += uint64(len(data))
		s.mu.Unlock()
		if client == nil {
			if msg.Type != "hello" {
				ws.closeWith(1008, "hello required")
				return
			}
			c, ok := s.acceptHello(ws, remote, msg)
			if !ok {
				return
			}
			client = c
			_ = ws.conn.SetReadDeadline(time.Time{})
			continue
		}
		if msg.Type == "state" {
			s.acceptState(client, msg)
		} else if msg.Type == "combat" {
			s.acceptCombat(client, msg)
		}
	}
}
func (s *relayServer) heartbeat() {
	s.mu.RLock()
	clients := make([]*relayClient, 0, len(s.clients))
	for _, cl := range s.clients {
		clients = append(clients, cl)
	}
	s.mu.RUnlock()
	for _, c := range clients {
		if !c.Pong.Swap(false) {
			c.WS.close()
			continue
		}
		if err := c.WS.writeFrame(wsPing, nil); err != nil {
			c.WS.close()
		}
	}
}
func (s *relayServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	players := len(s.clients)
	s.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "network": globalNetwork, "protocol": protocol, "players": players})
}
func detectLAN() string {
	ifaces, _ := net.InterfaceAddrs()
	var fallback string
	for _, addr := range ifaces {
		ipnet, ok := addr.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipnet.IP.To4()
		if ip == nil || ip.IsLoopback() {
			continue
		}
		if ip.IsPrivate() {
			return ip.String()
		}
		if fallback == "" {
			fallback = ip.String()
		}
	}
	return fallback
}
func (s *relayServer) lookupPublicIP(ctx context.Context) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://1.1.1.1/cdn-cgi/trace", nil)
	resp, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "ip=") {
			candidate := strings.TrimSpace(strings.TrimPrefix(line, "ip="))
			ip := net.ParseIP(candidate)
			if ip != nil && ip.To4() != nil {
				s.mu.Lock()
				s.publicIP = ip.String()
				s.mu.Unlock()
			}
			break
		}
	}
}
func openBrowser(port int) {
	if runtime.GOOS != "windows" {
		return
	}
	p := fmt.Sprintf("http://127.0.0.1:%d/dashboard", port)
	_ = exec.Command(`C:\Windows\System32\rundll32.exe`, "url.dll,FileProtocolHandler", p).Start()
}
func main() {
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	cfg := readINI(filepath.Join(filepath.Dir(exe), "relay.ini"))
	if port := os.Getenv("PORT"); port != "" {
		if p, err := strconv.Atoi(port); err == nil && p > 0 && p <= 65535 {
			cfg.Port = p
		}
	}
	s := newRelay(cfg)
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.healthHandler)
	mux.HandleFunc("/dashboard", s.dashboardHandler)
	mux.HandleFunc("/api/stats", s.statsHandler)
	mux.HandleFunc("/", s.wsHandler)
	server := &http.Server{Addr: fmt.Sprintf("0.0.0.0:%d", cfg.Port), Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	if cfg.PublicIPLookup {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		go s.lookupPublicIP(ctx)
	}
	go func() {
		t := time.NewTicker(250 * time.Millisecond)
		defer t.Stop()
		for range t.C {
			s.snapshotBroadcast()
		}
	}()
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for range t.C {
			s.heartbeat()
		}
	}()
	s.logEvent("RK Tactical Relay %s Protocol 3 listening on TCP %d", versionLabel, cfg.Port)
	if cfg.OpenDashboard {
		go func() { time.Sleep(350 * time.Millisecond); openBrowser(cfg.Port) }()
	}
	log.Fatal(server.ListenAndServe())
}
