package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"

	"google.golang.org/grpc"
)

type event struct {
	Event    string `json:"event"`
	Endpoint string `json:"endpoint,omitempty"`
	ID       uint64 `json:"id,omitempty"`
	Token    string `json:"token,omitempty"`
}

type events struct {
	mu      sync.Mutex
	encoder *json.Encoder
	nextID  atomic.Uint64
}

func newEvents(output io.Writer) *events {
	return &events{encoder: json.NewEncoder(output)}
}

func (e *events) emit(value event) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.encoder.Encode(value); err != nil {
		fmt.Fprintln(os.Stderr, "write fixture event:", err)
	}
}

func (e *events) observe(host any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handle grpc.StreamHandler) error {
	if !strings.HasSuffix(info.FullMethod, "/Connect") {
		return handle(host, stream)
	}
	id := e.nextID.Add(1)
	e.emit(event{Event: "connected", ID: id})
	err := handle(host, stream)
	e.emit(event{Event: "released", ID: id})
	return err
}
