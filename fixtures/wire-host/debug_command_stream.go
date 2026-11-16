package main

import (
	wirev1 "github.com/MontFerret/wire/gen/ferret/wire/v1"
	"google.golang.org/grpc"
)

type debugCommandStream struct {
	grpc.ServerStream
	events *events
}

func (s *debugCommandStream) RecvMsg(message any) error {
	if err := s.ServerStream.RecvMsg(message); err != nil {
		return err
	}
	request := message.(*wirev1.RunCommandRequest)
	if request.GetCommand() == wirev1.DebugCommand_DEBUG_COMMAND_START {
		id, ok := s.events.ids.Load(request.GetConnectionId().GetValue())
		if !ok {
			// Still expose unexpected starts after their binding was released.
			s.events.emit(event{Event: "debugStart"})
		} else {
			s.events.emit(event{Event: "debugStart", ID: id.(uint64)})
		}
	}
	return nil
}
