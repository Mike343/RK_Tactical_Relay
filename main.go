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
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"
)

const (
	versionLabel           = "1.4.0-source-reconstruction"
	globalNetwork          = "rk-tactical-global"
	maxPlayers             = 1024
	maxPendingHello        = 256
	stateExpiry            = 10 * time.Second
	magic           uint32 = 0x31504d52
	protocol        uint32 = 3
	snapshotVersion uint32 = 4
	snapshotSize           = 3864
	contactSize            = 120
	maxContacts            = 32
	outQueueSize           = 64
	combatBurst            = 300.0
	combatPerSecond        = 300.0
	maxLogLines            = 180
)

type aircraftState struct {
	Lat, Lon, AltFt, Heading, SpeedKts float64
	Aircraft                           string
}

type relayClient struct {
	ID, Name, IP           string
	Source                 uint32
	WS                     *webSocket
	State                  *aircraftState
	LastState, LastMessage time.Time
	Pong                   atomic.Bool
	Joined                 time.Time
	Team, Flight           uint32
	flightSeen             bool
	Detected               []uint32
	MaxAltFt, MaxSpeedKts  float64
	*outbox
	ready        atomic.Bool
	combatTokens float64
	combatStamp  time.Time

	Client                 string
	Protocol               uint32
	viewSig                uint64
	viewLogged, dropLogged time.Time
	lastDrop               time.Time
	staleLogged            atomic.Bool
	noStateLogged          atomic.Bool
	stateLogged            bool
	Track                  []trackPoint
	Events                 []flightEvent
	lastTrack              time.Time
	trackEvery             time.Duration
	lastGun, lastFlare     time.Time
}

type totals struct {
	Connects, Disconnects, State, Combat, CombatRejected, CombatDelivered, Snapshot, SnapshotsDropped, SlowDisconnects, BytesIn, BytesOut uint64
	ByEvent                                                                                                                               [10]uint64
}

type counters struct {
	Connects, Disconnects, State, Combat, CombatRejected, CombatDelivered, Snapshot, SnapshotsDropped, SlowDisconnects, BytesIn, BytesOut atomic.Uint64
	ByEvent                                                                                                                               [10]atomic.Uint64
}

func (c *counters) load() totals {
	t := totals{Connects: c.Connects.Load(), Disconnects: c.Disconnects.Load(), State: c.State.Load(), Combat: c.Combat.Load(), CombatRejected: c.CombatRejected.Load(), CombatDelivered: c.CombatDelivered.Load(), Snapshot: c.Snapshot.Load(), SnapshotsDropped: c.SnapshotsDropped.Load(), SlowDisconnects: c.SlowDisconnects.Load(), BytesIn: c.BytesIn.Load(), BytesOut: c.BytesOut.Load()}
	for i := range c.ByEvent {
		t.ByEvent[i] = c.ByEvent[i].Load()
	}
	return t
}

type relayServer struct {
	mu                sync.RWMutex
	clients           map[*webSocket]*relayClient
	sequence          atomic.Uint32
	pending           atomic.Int32
	kick              chan struct{}
	cfg               config
	started           time.Time
	counts            counters
	logLines          []string
	lanIP, publicIP   string
	remotelyConfirmed bool
	remote            map[string]remoteContact
	peers             map[string]*peerLink
	dialing           map[string]bool
	podID             string
	draining          atomic.Bool
	ipMu              sync.Mutex
	ipConns           map[string]int
	histMu            sync.Mutex
	heartbeatTicks    int
	history           []sessionRecord
}

func newRelay(cfg config) *relayServer {
	podID := cfg.PodName
	if podID == "" {
		podID, _ = os.Hostname()
	}
	return &relayServer{clients: make(map[*webSocket]*relayClient), remote: make(map[string]remoteContact), peers: make(map[string]*peerLink), dialing: make(map[string]bool), kick: make(chan struct{}, 1), cfg: cfg, started: time.Now(), lanIP: detectLAN(), podID: podID}
}

func (s *relayServer) addBytesOut(n int) {
	s.counts.BytesOut.Add(uint64(n))
}

func newClient(id, name, ip string, ws *webSocket, stats *counters) *relayClient {
	c := &relayClient{ID: id, Name: name, IP: ip, Source: panelContactID(id), WS: ws, Joined: time.Now(), outbox: newOutbox(ws, stats)}
	c.Pong.Store(true)
	return c
}

func (c *relayClient) allowCombat(now time.Time) bool {
	if c.combatStamp.IsZero() {
		c.combatTokens = combatBurst
	} else {
		c.combatTokens = math.Min(combatBurst, c.combatTokens+now.Sub(c.combatStamp).Seconds()*combatPerSecond)
	}
	c.combatStamp = now
	if c.combatTokens < 1 {
		return false
	}
	c.combatTokens--
	return true
}

func cleanText(s string, limit int) string {
	var b strings.Builder
	count := 0
	for _, r := range s {
		if r < 32 || r == 127 {
			continue
		}
		b.WriteRune(r)
		count++
		if count >= limit {
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

func (s *relayServer) logEvent(format string, args ...any) {
	msg := fmt.Sprintf("[%s] %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
	log.Print(msg)
	s.mu.Lock()
	s.logLines = append(s.logLines, msg)
	if len(s.logLines) > maxLogLines*2 {
		s.logLines = append([]string(nil), s.logLines[len(s.logLines)-maxLogLines:]...)
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
	ip := net.ParseIP(remoteIP(r.RemoteAddr))
	if ip == nil || !ip.IsLoopback() {
		return false
	}
	for _, h := range []string{"X-Forwarded-For", "X-Real-Ip", "Forwarded"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	host := strings.Trim(remoteIP(r.Host), "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	hostIP := net.ParseIP(host)
	return hostIP != nil && hostIP.IsLoopback()
}

func distanceKey(viewer, other *aircraftState) float64 {
	if viewer == nil || other == nil {
		return 0
	}
	latRad := viewer.Lat * math.Pi / 180
	dlat := other.Lat - viewer.Lat
	delta := other.Lon - viewer.Lon
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
	for n > 0 && n < len(b) && !utf8.RuneStart(b[n]) {
		n--
	}
	copy(buf[:n], b[:n])
}

type contact struct {
	id     string
	hash   uint32
	name   string
	state  aircraftState
	joined time.Time

	team     uint32
	detected []uint32
	panel    uint32
}

func (s *relayServer) contactsLocked(now time.Time) []contact {
	out := make([]contact, 0, len(s.clients)+len(s.remote))
	local := make(map[string]struct{}, len(s.clients))
	for _, c := range s.clients {
		local[c.ID] = struct{}{}
		if c.State != nil && now.Sub(c.LastState) <= stateExpiry {
			out = append(out, contact{id: c.ID, hash: hashID(c.ID), name: c.Name, state: *c.State, joined: c.Joined, team: c.Team, detected: c.Detected, panel: panelContactID(c.ID)})
		}
	}
	for id, rc := range s.remote {
		if _, dup := local[id]; dup || now.Sub(rc.seen) > stateExpiry {
			continue
		}
		out = append(out, rc.contact)
	}
	return out
}

func (s *relayServer) nextSequence() uint32 {
	for {
		if v := s.sequence.Add(1); v != 0 {
			return v
		}
	}
}

func buildSnapshot(seq uint32, viewerID string, viewerTeam uint32, viewer *aircraftState, contacts []contact, openTeams bool) []byte {
	order := nearest(viewerID, viewer, contacts)
	allies := alliesOf(viewerTeam, contacts)
	buf := make([]byte, snapshotSize)
	binary.LittleEndian.PutUint32(buf[0:4], magic)
	binary.LittleEndian.PutUint32(buf[4:8], snapshotVersion)
	binary.LittleEndian.PutUint32(buf[8:12], snapshotSize)
	binary.LittleEndian.PutUint32(buf[12:16], seq)
	binary.LittleEndian.PutUint32(buf[16:20], uint32(len(order)))
	for i, r := range order {
		c := &contacts[r.idx]
		o := 24 + i*contactSize
		binary.LittleEndian.PutUint32(buf[o:o+4], c.hash)
		flags := c.team
		if openTeams || teamDetects(viewerTeam, c, allies) {
			flags |= flagTracked
		}
		binary.LittleEndian.PutUint32(buf[o+4:o+8], flags)
		binary.LittleEndian.PutUint64(buf[o+8:o+16], math.Float64bits(c.state.Lat))
		binary.LittleEndian.PutUint64(buf[o+16:o+24], math.Float64bits(c.state.Lon))
		binary.LittleEndian.PutUint64(buf[o+24:o+32], math.Float64bits(c.state.AltFt))
		binary.LittleEndian.PutUint32(buf[o+32:o+36], math.Float32bits(float32(c.state.Heading)))
		binary.LittleEndian.PutUint32(buf[o+36:o+40], math.Float32bits(float32(c.state.SpeedKts)))
		putText(buf[o+40:o+72], c.name)
		putText(buf[o+72:o+120], c.state.Aircraft)
	}
	return buf
}

func (s *relayServer) snapshotFor(viewer *relayClient) []byte {
	var viewerID string
	var viewerTeam uint32
	var viewerState *aircraftState
	s.mu.RLock()
	if viewer != nil {
		viewerID = viewer.ID
		viewerTeam = viewer.Team
		if viewer.State != nil {
			stateCopy := *viewer.State
			viewerState = &stateCopy
		}
	}
	contacts := s.contactsLocked(time.Now())
	s.mu.RUnlock()
	s.counts.Snapshot.Add(1)
	return buildSnapshot(s.nextSequence(), viewerID, viewerTeam, viewerState, contacts, s.openTeams())
}

func (s *relayServer) snapshotBroadcast() {
	type target struct {
		c     *relayClient
		team  uint32
		state *aircraftState
	}
	s.mu.RLock()
	contacts := s.contactsLocked(time.Now())
	targets := make([]target, 0, len(s.clients))
	for _, c := range s.clients {
		if !c.ready.Load() {
			continue
		}
		t := target{c: c, team: c.Team}
		if c.State != nil {
			stateCopy := *c.State
			t.state = &stateCopy
		}
		targets = append(targets, t)
	}
	s.mu.RUnlock()
	workers := min(runtime.GOMAXPROCS(0), max(1, len(targets)/64))
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := w; i < len(targets); i += workers {
				t := targets[i]
				b := buildSnapshot(s.nextSequence(), t.c.ID, t.team, t.state, contacts, s.openTeams())
				t.c.enqueueSnapshot(b)
				s.noteView(t.c, t.team, b)
			}
		}(w)
	}
	wg.Wait()
	s.counts.Snapshot.Add(uint64(len(targets)))
}

func (s *relayServer) requestBroadcast() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

func (s *relayServer) broadcastLoop(ctx context.Context) {
	t := time.NewTicker(250 * time.Millisecond)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		case <-s.kick:
		}
		s.snapshotBroadcast()
	}
}

func (s *relayServer) acceptHello(ws *webSocket, remote string, msg wireMessage) (*relayClient, bool) {
	if !msg.Protocol.ok || (msg.Protocol.v != float64(protocol) && msg.Protocol.v != float64(snapshotVersion)) {
		s.logEvent("REJECT address=%s reason=unsupported_protocol", remote)
		_ = ws.writeFrame(wsText, []byte(`{"type":"error","message":"unsupported protocol"}`))
		ws.closeWith(1002, "unsupported protocol")
		return nil, false
	}
	id := cleanText(string(msg.ID), 64)
	name := cleanText(string(msg.Name), 40)
	if name == "" {
		name = "RK Pilot"
	}
	if id == "" || !allIDCharacters(id) {
		s.logEvent("REJECT address=%s reason=invalid_identity", remote)
		ws.closeWith(1008, "invalid identity")
		return nil, false
	}
	c := newClient(id, name, remote, ws, &s.counts)
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
		s.logEvent("REJECT address=%s reason=network_full", remote)
		ws.closeWith(1013, "network full")
		return nil, false
	}
	delete(s.remote, id)
	c.Name = s.uniqueNameLocked(name, id, time.Now())
	s.clients[ws] = c
	s.counts.Connects.Add(1)
	if !isPrivateIP(remote) {
		s.remotelyConfirmed = true
	}
	users := len(s.clients)
	s.mu.Unlock()
	for _, old := range replaced {
		old.WS.closeWith(4001, "identity reconnected")
		s.logEvent("REPLACED name=%q id=%s address=%s reason=identity_reconnected", old.Name, old.ID, old.IP)
	}
	c.Client = cleanText(string(msg.Client), 80)
	c.Protocol = uint32(msg.Protocol.v)
	if c.Name != name {
		s.logEvent("CONNECT name=%q renamed=%q id=%s address=%s users=%d proto=%d client=%q", name, c.Name, id, remote, users, c.Protocol, c.Client)
	} else {
		s.logEvent("CONNECT name=%q id=%s address=%s users=%d proto=%d client=%q", name, id, remote, users, c.Protocol, c.Client)
	}
	welcome := struct {
		Type     string `json:"type"`
		Protocol uint32 `json:"protocol"`
		ID       string `json:"id"`
		Name     string `json:"name"`
		Network  string `json:"network"`
	}{"welcome", uint32(msg.Protocol.v), id, c.Name, globalNetwork}
	b, _ := json.Marshal(welcome)
	if err := ws.writeFrame(wsText, b); err != nil {
		s.mu.Lock()
		delete(s.clients, ws)
		s.mu.Unlock()
		ws.close()
		return nil, false
	}
	go s.safely("client writer", func() { c.outbox.run(s.addBytesOut) })
	c.ready.Store(true)
	s.requestBroadcast()
	s.broadcastPeers(peerEnvelope{T: "join", ID: id})
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
	notes, dropped := s.acceptStateLocked(c, m, now)
	s.mu.Unlock()
	if dropped != "" {
		s.logStateDrop(c, dropped)
	}
	for _, note := range notes {
		s.logEvent("%s", note)
	}
}

func (s *relayServer) acceptStateLocked(c *relayClient, m wireMessage, now time.Time) ([]string, string) {
	if now.Sub(c.LastMessage) < 100*time.Millisecond {
		return nil, ""
	}
	c.LastMessage = now
	if !m.Lat.inRange(-90, 90) || !m.Lon.inRange(-180, 180) || !m.AltFt.inRange(-2000, 200000) || !m.Heading.inRange(-360, 720) || !m.SpeedKts.inRange(0, 10000) {
		return nil, fmt.Sprintf("out_of_range lat=%v lon=%v altFt=%v heading=%v speedKts=%v", m.Lat.v, m.Lon.v, m.AltFt.v, m.Heading.v, m.SpeedKts.v)
	}
	team, teamOK := m.Team.unsigned(2)
	flight, flightOK := m.Flight.unsigned(^uint32(0))
	if (m.Team.ok && !teamOK) || (m.Flight.ok && !flightOK) {
		return nil, fmt.Sprintf("bad_team_or_flight team=%v flight=%v", m.Team.v, m.Flight.v)
	}
	oldTeam, oldFlight := c.Team, c.Flight
	if !c.flightSeen || c.Flight != flight {
		c.flightSeen = true
		c.Flight = flight
		c.Team = 0
	}
	if c.Team == 0 && team != 0 {
		c.Team = team
	}
	c.Detected = m.Detected
	c.State = &aircraftState{Lat: m.Lat.v, Lon: m.Lon.v, AltFt: m.AltFt.v, Heading: normalizeHeading(m.Heading.v), SpeedKts: m.SpeedKts.v, Aircraft: cleanText(string(m.Aircraft), 80)}
	c.MaxAltFt = math.Max(c.MaxAltFt, m.AltFt.v)
	c.MaxSpeedKts = math.Max(c.MaxSpeedKts, m.SpeedKts.v)
	c.LastState = now
	c.sampleTrackLocked(now)
	s.counts.State.Add(1)

	var notes []string
	if s.tracing() {
		if !c.stateLogged {
			c.stateLogged = true
			notes = append(notes, fmt.Sprintf("STATE_FIRST name=%q aircraft=%q team=%d flight=%d lat=%.3f lon=%.3f altFt=%.0f detected=%d", c.Name, c.State.Aircraft, c.Team, c.Flight, c.State.Lat, c.State.Lon, c.State.AltFt, len(c.Detected)))
		} else if c.Team != oldTeam || c.Flight != oldFlight {
			notes = append(notes, fmt.Sprintf("TEAM name=%q team=%d->%d flight=%d->%d", c.Name, oldTeam, c.Team, oldFlight, c.Flight))
		}
		if c.staleLogged.Swap(false) {
			notes = append(notes, fmt.Sprintf("STATE_RESUME name=%q", c.Name))
		}
	}
	return notes, ""
}

func combatName(v uint32) string {
	return []string{"NONE", "LAUNCH", "END", "HIT", "COUNTERMEASURE", "UPDATE", "EXPLOSION", "EVENT7", "EVENT8", "EVENT9"}[v]
}

func weaponName(v uint32) string {
	return []string{"NONE", "AIM120", "AIM9", "TRACER", "CHAFF", "FLARE"}[v]
}

type combatMessage struct {
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

func (s *relayServer) rejectCombat(c *relayClient, reason string, quiet bool) {
	s.counts.CombatRejected.Add(1)
	if !quiet {
		s.logEvent("COMBAT_REJECT name=%q id=%s reason=%s", c.Name, c.ID, reason)
		return
	}
	now := time.Now()
	if s.tracing() && now.Sub(c.lastDrop) >= dropLogGap {
		c.lastDrop = now
		s.logEvent("COMBAT_DROP name=%q reason=%s", c.Name, reason)
	}
}

func (s *relayServer) deliverCombat(base combatMessage, from *relayClient) int {
	plain, _ := json.Marshal(base)
	var targeted []byte
	type recipient struct {
		c    *relayClient
		team uint32
	}
	s.mu.RLock()
	others := make([]recipient, 0, len(s.clients))
	for _, cl := range s.clients {
		if cl != from && cl.ready.Load() {
			others = append(others, recipient{cl, cl.Team})
		}
	}
	s.mu.RUnlock()
	attackerSolo := (base.Flags>>4)&3 == 0
	delivered := 0
	for _, r := range others {
		dest := r.c
		if base.Event == 4 && !s.openTeams() && attackerSolo != (r.team == 0) {
			continue
		}
		localTarget := dest.Source == base.Target
		if localTarget && base.Event == 3 {
			attacker := s.nameForPanel(base.Source)
			if from != nil {
				attacker = from.Name
			}
			s.recordHitTaken(dest, base, attacker)
		}
		if base.Event == 3 && !localTarget {
			continue
		}
		payload := plain
		if localTarget {
			if targeted == nil {
				copyMessage := base
				copyMessage.Flags |= 1
				targeted, _ = json.Marshal(copyMessage)
			}
			payload = targeted
		}
		if dest.enqueue(wsText, payload) {
			delivered++
		}
	}
	return delivered
}

func (s *relayServer) acceptCombat(c *relayClient, m wireMessage) {
	event, eventOK := m.Event.unsigned(9)
	weapon, weaponOK := m.Weapon.unsigned(5)
	target, targetOK := m.Target.unsigned(^uint32(0))
	weaponID, weaponIDOK := m.WeaponID.unsigned(^uint32(0))
	flags, flagsOK := m.Flags.unsigned(^uint32(0))
	valid := eventOK && event > 0 && weaponOK && weapon > 0 && targetOK && weaponIDOK && flagsOK && m.Lat.inRange(-90, 90) && m.Lon.inRange(-180, 180) && m.AltFt.inRange(-2000, 200000) && m.Heading.inRange(-360, 720) && m.Damage.inRange(0, 1000) && m.Duration.inRange(0, 300) && m.MissDistance.inRange(0, 10000000)
	if !valid {
		s.rejectCombat(c, "invalid_event", false)
		return
	}
	if !c.allowCombat(time.Now()) {
		s.rejectCombat(c, "rate_limited", true)
		return
	}
	source := c.Source
	if source == 0 {
		source = panelContactID(c.ID)
	}
	base := combatMessage{"combat", event, weapon, source, target, weaponID, flags, m.Lat.v, m.Lon.v, m.AltFt.v, normalizeHeading(m.Heading.v), m.Damage.v, m.Duration.v, m.MissDistance.v}
	var victimName string
	if event >= 7 {
		if (event == 8 && c.Team != 1) || (event == 9 && c.Team != 2) || (event == 7 && c.Team == 0) {
			s.rejectCombat(c, "team_event", true)
			return
		}
		if event == 7 && !((target >= 1 && target <= 3) || (target >= 101 && target <= 136) || (target >= 201 && target <= 216)) {
			s.rejectCombat(c, "team_event", true)
			return
		}
		base.Weapon, base.Flags, base.Damage, base.Duration, base.MissDistance = 3, c.Team<<4, 0, 0, 0
	} else {
		defense := flags&64 != 0
		attacker := c.Team
		if defense {
			attacker = (flags >> 4) & 3
		}
		if defense && attacker != 1 && attacker != 2 {
			s.rejectCombat(c, "team_event", true)
			return
		}
		if target != 0 {
			victim, hasState, allies := s.combatContext(target, attacker, event == 1 && !defense && !s.openTeams(), time.Now())
			if victim != nil {
				victimName = victim.name
			}
			switch {
			case victim == nil && !s.openTeams():
				s.rejectCombat(c, fmt.Sprintf("unknown_target target=%d", target), true)
				return
			case victim != nil && !s.teamsMayFight(attacker, victim.team, weapon):
				s.rejectCombat(c, fmt.Sprintf("team_rules attacker=%d victim=%d weapon=%d", attacker, victim.team, weapon), true)
				return
			case victim != nil && !s.openTeams() && event == 1 && !defense && hasState && !teamDetects(c.Team, victim, allies):
				s.rejectCombat(c, fmt.Sprintf("not_detected attacker=%d victim=%d", attacker, victim.team), true)
				return
			}
		}
		base.Flags = (flags &^ 49) | attacker<<4
	}
	delivered := s.deliverCombat(base, c)
	s.forwardCombat(base)
	s.counts.Combat.Add(1)
	if event < 7 {
		s.recordCombatEvent(c, base, victimName)
	}
	s.counts.CombatDelivered.Add(uint64(delivered))
	s.counts.ByEvent[base.Event].Add(1)
	if base.Event != 5 {
		s.logEvent("COMBAT %s weapon=%s from=%q source=%d target=%d delivered=%d", combatName(base.Event), weaponName(base.Weapon), c.Name, source, base.Target, delivered)
	}
}

func (s *relayServer) wsHandler(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		http.Error(w, "draining", http.StatusServiceUnavailable)
		return
	}
	ws, err := upgradeWS(w, r)
	if err != nil {
		return
	}
	defer ws.close()
	if s.pending.Add(1) > maxPendingHello {
		s.pending.Add(-1)
		ws.closeWith(1013, "server busy")
		return
	}
	awaitingHello := true
	defer func() {
		if awaitingHello {
			s.pending.Add(-1)
		}
	}()
	remote := s.cfg.clientIP(r)
	if !s.acquireIP(remote) {
		ws.closeWith(1013, "too many connections")
		return
	}
	defer s.releaseIP(remote)
	var client *relayClient
	defer func() {
		if client == nil {
			return
		}
		s.mu.Lock()
		_, ok := s.clients[ws]
		if ok {
			delete(s.clients, ws)
			s.counts.Disconnects.Add(1)
		}
		users := len(s.clients)
		s.mu.Unlock()
		if ok {
			s.logEvent("DISCONNECT name=%q id=%s address=%s users=%d", client.Name, client.ID, remote, users)
			s.requestBroadcast()
			s.broadcastPeers(peerEnvelope{T: "leave", ID: client.ID})
			s.finishSession(client, time.Now())
		}
	}()
	_ = ws.conn.SetReadDeadline(time.Now().Add(12 * time.Second))
	for {
		opcode, data, err := ws.readMessage(func() {
			if client != nil {
				client.Pong.Store(true)
				_ = ws.conn.SetReadDeadline(time.Now().Add(clientIdle))
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
		if json.Unmarshal(data, &msg) != nil {
			ws.closeWith(1007, "invalid JSON")
			return
		}
		s.counts.BytesIn.Add(uint64(len(data)))
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
			awaitingHello = false
			s.pending.Add(-1)
			_ = ws.conn.SetReadDeadline(time.Now().Add(clientIdle))
			continue
		}
		_ = ws.conn.SetReadDeadline(time.Now().Add(clientIdle))
		switch msg.Type {
		case "state":
			s.acceptState(client, msg)
		case "combat":
			s.acceptCombat(client, msg)
		}
	}
}

func (s *relayServer) heartbeat() {
	now := time.Now()
	s.mu.RLock()
	clients := make([]*relayClient, 0, len(s.clients))
	views := make([]heartbeatView, 0, len(s.clients))
	for _, cl := range s.clients {
		clients = append(clients, cl)
		views = append(views, heartbeatView{c: cl, hasState: cl.State != nil, stateAge: now.Sub(cl.LastState), connected: now.Sub(cl.Joined)})
	}
	s.mu.RUnlock()
	s.heartbeatTicks++
	s.traceHeartbeat(views, s.heartbeatTicks)
	for _, c := range clients {
		if !c.Pong.Swap(false) {
			c.WS.close()
			continue
		}
		c.enqueue(wsPing, nil)
	}
}

func (s *relayServer) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.heartbeat()
		}
	}
}

func (s *relayServer) closeAll() {
	s.mu.RLock()
	clients := make([]*relayClient, 0, len(s.clients))
	for _, cl := range s.clients {
		clients = append(clients, cl)
	}
	s.mu.RUnlock()
	for _, c := range clients {
		c.WS.closeWith(1001, "server shutting down")
	}
}

func (s *relayServer) healthHandler(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	players := len(s.clients)
	s.mu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "network": globalNetwork, "protocol": protocol, "players": players, "peers": s.peerCount()})
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
	ctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
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

func (s *relayServer) routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.healthHandler)
	mux.HandleFunc("/ready", s.readyHandler)
	mux.HandleFunc("/dashboard", s.dashboardHandler)
	mux.HandleFunc("/api/stats", s.statsHandler)
	mux.HandleFunc("/api/public", s.publicHandler)
	mux.HandleFunc("/api/public/flight/", s.publicFlightHandler)
	mux.HandleFunc("/", s.wsHandler)
	return mux
}

func main() {
	log.SetFlags(0)
	exe, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	cfg := applyEnv(readINI(filepath.Join(filepath.Dir(exe), "relay.ini")))
	s := newRelay(cfg)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	loopCtx, stopLoops := context.WithCancel(context.Background())
	defer stopLoops()
	server := &http.Server{Addr: fmt.Sprintf(":%d", cfg.Port), Handler: s.routes(), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	if cfg.PublicIPLookup {
		go s.lookupPublicIP(ctx)
	}
	s.supervise(loopCtx, "broadcast", func() { s.broadcastLoop(loopCtx) })
	s.supervise(loopCtx, "heartbeat", func() { s.heartbeatLoop(loopCtx) })
	if cfg.peeringEnabled() {
		peerServer := &http.Server{Addr: fmt.Sprintf(":%d", cfg.PeerPort), Handler: s.peerRoutes(), ReadHeaderTimeout: 5 * time.Second}
		go func() { serverErrFatal(peerServer.ListenAndServe()) }()
		s.supervise(loopCtx, "peer sync", func() { s.peerLoop(loopCtx) })
		s.supervise(loopCtx, "peer dial", func() { s.dialLoop(loopCtx) })
		s.logEvent("PEERING enabled dns=%s port=%d pod=%s ip=%s", cfg.PeerDNS, cfg.PeerPort, s.podID, s.ownIP())
	}
	s.logEvent("RK Tactical Relay %s Protocol 3 listening on TCP %d", versionLabel, cfg.Port)
	if cfg.OpenDashboard {
		go func() { time.Sleep(350 * time.Millisecond); openBrowser(cfg.Port) }()
	}
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.ListenAndServe() }()
	select {
	case err := <-serverErr:
		log.Fatal(err)
	case <-ctx.Done():
	}
	s.logEvent("shutting down")
	s.drain(context.Background())
	s.closeAll()
	stopLoops()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = server.Shutdown(shutdownCtx)
}

func serverErrFatal(err error) {
	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type ranked struct {
	idx int
	key float64
}

func nearest(viewerID string, viewer *aircraftState, contacts []contact) []ranked {
	best := make([]ranked, 0, maxContacts)
	before := func(a, b ranked) bool {
		if a.key != b.key {
			return a.key < b.key
		}
		if !contacts[a.idx].joined.Equal(contacts[b.idx].joined) {
			return contacts[a.idx].joined.Before(contacts[b.idx].joined)
		}
		return contacts[a.idx].id < contacts[b.idx].id
	}
	for i := range contacts {
		if contacts[i].id == viewerID {
			continue
		}
		r := ranked{i, distanceKey(viewer, &contacts[i].state)}
		if len(best) == maxContacts && !before(r, best[maxContacts-1]) {
			continue
		}
		pos := sort.Search(len(best), func(j int) bool { return before(r, best[j]) })
		if len(best) < maxContacts {
			best = append(best, ranked{})
		}
		copy(best[pos+1:], best[pos:])
		best[pos] = r
	}
	return best
}
