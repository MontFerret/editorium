package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// A barrier applies to the next matching operation only. The application keeps
// serving other connections while the test holds it.
type barriers struct {
	mu     sync.Mutex
	armed  map[string]chan struct{}
	held   map[string]chan struct{}
	events *events
}

func newBarriers(events *events) *barriers {
	return &barriers{armed: make(map[string]chan struct{}), held: make(map[string]chan struct{}), events: events}
}

func (b *barriers) wait(ctx context.Context, name string, id uint64) (bool, error) {
	b.mu.Lock()
	gate, ok := b.armed[name]
	delete(b.armed, name)
	b.mu.Unlock()
	if !ok {
		return false, nil
	}
	b.events.emit(event{Event: "held", Token: name, ID: id})
	select {
	case <-ctx.Done():
		b.events.emit(event{Event: "interrupted", Token: name, ID: id})
		return true, ctx.Err()
	case <-gate:
		return true, ctx.Err()
	}
}

func (b *barriers) read(input io.Reader) error {
	scanner := bufio.NewScanner(input)
	for scanner.Scan() {
		var cmd struct{ Action, Name string }
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			return err
		}
		if err := b.command(cmd.Action, cmd.Name); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (b *barriers) command(action, name string) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch action {
	case "arm":
		if _, ok := b.held[name]; ok {
			return fmt.Errorf("barrier %q is already armed", name)
		}
		gate := make(chan struct{})
		b.armed[name], b.held[name] = gate, gate
		b.events.emit(event{Event: "armed", Token: name})
	case "release":
		if gate := b.held[name]; gate != nil {
			close(gate)
			delete(b.held, name)
			delete(b.armed, name)
		}
	case "releaseAll":
		for name, gate := range b.held {
			close(gate)
			delete(b.held, name)
		}
		clear(b.armed)
	default:
		return fmt.Errorf("unknown barrier action %q", action)
	}
	return nil
}
