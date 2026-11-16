package main

import (
	wirev1 "github.com/MontFerret/wire/gen/ferret/wire/v1"
	"google.golang.org/grpc"
)

type connectStream struct {
	grpc.ServerStream
	events     *events
	id         uint64
	connection string
}

func (s *connectStream) SendMsg(message any) error {
	response := message.(*wirev1.ConnectResponse)
	s.connection = response.GetConnectionId().GetValue()
	s.events.ids.Store(s.connection, s.id)
	if _, err := s.events.controls.wait(s.Context(), "connect", s.id); err != nil {
		return err
	}
	return s.ServerStream.SendMsg(message)
}
