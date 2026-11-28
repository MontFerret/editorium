package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"sync/atomic"

	wirev1 "github.com/MontFerret/wire/gen/ferret/wire/v1"
	"google.golang.org/grpc"
)

type event struct {
	Event    string               `json:"event"`
	Endpoint string               `json:"endpoint,omitempty"`
	ID       uint64               `json:"id,omitempty"`
	Root     *string              `json:"root,omitempty"`
	Token    string               `json:"token,omitempty"`
	Page     *wirev1.VariablePage `json:"page,omitempty"`
	Reads    *int64               `json:"reads,omitempty"`
}

type events struct {
	mu           sync.Mutex
	encoder      *json.Encoder
	nextID       atomic.Uint64
	ids          sync.Map
	controls     *barriers
	reads        atomic.Int64
	incompatible bool
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
	if info.FullMethod == wirev1.DebugService_RunCommand_FullMethodName && e.controls != nil {
		return handle(host, &debugCommandStream{ServerStream: stream, events: e})
	}
	if info.FullMethod != wirev1.RuntimeService_Connect_FullMethodName {
		return handle(host, stream)
	}
	id := e.nextID.Add(1)
	e.emit(event{Event: "connected", ID: id})
	var observed *connectStream
	if e.controls != nil {
		observed = &connectStream{ServerStream: stream, events: e, id: id}
		stream = observed
	}
	err := handle(host, stream)
	if observed != nil {
		e.ids.Delete(observed.connection)
	}
	e.emit(event{Event: "released", ID: id})
	return err
}

func (e *events) observeOperation(ctx context.Context, request any, _ *grpc.UnaryServerInfo, handle grpc.UnaryHandler) (any, error) {
	owned, ok := request.(interface{ GetConnectionId() *wirev1.ConnectionId })
	if !ok {
		return handle(ctx, request)
	}
	value, ok := e.ids.Load(owned.GetConnectionId().GetValue())
	if !ok {
		return handle(ctx, request)
	}
	id := value.(uint64)
	var barrier string
	switch r := request.(type) {
	case *wirev1.VariablesRequest:
		barrier = "variables"
	case *wirev1.CompileRequest:
		e.emit(event{Event: "compile", Token: r.GetSource().GetName(), ID: id})
		barrier = "compile"
	case *wirev1.CreateSessionRequest:
		e.emit(event{Event: "runSession", Root: r.FsRoot, ID: id})
	case *wirev1.CreateDebugSessionRequest:
		e.emit(event{Event: "debugSession", Root: r.FsRoot, ID: id})
	case *wirev1.CloseConnectionRequest:
		barrier = "close"
	}
	if barrier != "" {
		if _, err := e.controls.wait(ctx, barrier, id); err != nil {
			return nil, err
		}
	}
	reply, err := handle(ctx, request)
	switch r := request.(type) {
	case *wirev1.EvaluateFrameRequest:
		reads := e.reads.Load()
		e.emit(event{Event: "evaluated", ID: id, Reads: &reads})
	case *wirev1.VariablesRequest:
		reads := e.reads.Load()
		e.emit(event{Event: "page", ID: id, Page: r.GetPage(), Reads: &reads})
	}
	if barrier == "close" && err == nil {
		e.emit(event{Event: "connectionClosed", ID: id})
	}
	return reply, err
}
