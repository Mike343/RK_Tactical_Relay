package main

import "sync/atomic"

type outFrame struct {
	op   byte
	data []byte
}

type outbox struct {
	ws    *webSocket
	out   chan outFrame
	snap  atomic.Pointer[[]byte]
	wake  chan struct{}
	stats *counters
}

func newOutbox(ws *webSocket, stats *counters) *outbox {
	return &outbox{ws: ws, out: make(chan outFrame, outQueueSize), wake: make(chan struct{}, 1), stats: stats}
}

func (o *outbox) enqueue(op byte, data []byte) bool {
	if o == nil {
		return false
	}
	select {
	case o.out <- outFrame{op, data}:
		return true
	default:
	}
	o.stats.SlowDisconnects.Add(1)
	o.ws.close()
	return false
}

func (o *outbox) enqueueSnapshot(data []byte) {
	if o == nil {
		return
	}
	if o.snap.Swap(&data) != nil {
		o.stats.SnapshotsDropped.Add(1)
	}
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

func (o *outbox) write(op byte, data []byte, written func(n int)) bool {
	if err := o.ws.writeFrame(op, data); err != nil {
		o.ws.close()
		return false
	}
	if op != wsPing {
		written(len(data))
	}
	return true
}

func (o *outbox) run(written func(n int)) {
	for {
		select {
		case f := <-o.out:
			if !o.write(f.op, f.data, written) {
				return
			}
		case <-o.wake:
			if p := o.snap.Swap(nil); p != nil && !o.write(wsBinary, *p, written) {
				return
			}
		case <-o.ws.done:
			return
		}
	}
}
