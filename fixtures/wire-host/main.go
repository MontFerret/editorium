package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"runtime/debug"
	"strings"
	"time"

	"github.com/MontFerret/api"
	"github.com/MontFerret/ferret/v2"
	"github.com/MontFerret/ferret/v2/pkg/runtime"
	"github.com/MontFerret/ferret/v2/uapi"
	"github.com/MontFerret/wire/server"
)

func main() {
	root := flag.String("root", ".", "application filesystem root")
	controlled := flag.Bool("control", false, "enable integration-test barriers on stdin")
	flag.Parse()
	if err := serve(*root, *controlled); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func coreVersion() (api.Version, error) {
	if build, ok := debug.ReadBuildInfo(); ok {
		for _, dep := range build.Deps {
			if dep.Path == "github.com/MontFerret/ferret/v2" && dep.Replace == nil && dep.Version != "" {
				return api.Version(strings.TrimPrefix(dep.Version, "v")), nil
			}
		}
	}
	return "", errors.New("missing Ferret Core module version in fixture build")
}

func serve(root string, controlled bool) (err error) {
	version, err := coreVersion()
	if err != nil {
		return err
	}
	events := newEvents(os.Stdout)
	options := []server.Option{server.WithStreamInterceptors(events.observe)}
	if controlled {
		events.controls = newBarriers(events)
		options = append(options, server.WithUnaryInterceptors(events.observeOperation))
	}
	host, err := uapi.New(version, ferret.WithFSRoot(root),
		ferret.WithFunctionsRegistrar(func(ns runtime.Namespace) {
			functions := ns.Namespace("DEMO").Function().A1()
			functions.Add("IDENTITY", func(_ context.Context, value runtime.Value) (runtime.Value, error) {
				return value, nil
			})
			functions.Add("BLOCK", func(ctx context.Context, token runtime.Value) (runtime.Value, error) {
				events.emit(event{Event: "entered", Token: token.String()})
				if controlled {
					if held, err := events.controls.wait(ctx, "block:"+token.String(), 0); held && err == nil {
						return token, nil
					}
				}
				<-ctx.Done()
				events.emit(event{Event: "cancelled", Token: token.String()})
				return nil, ctx.Err()
			})
		}), ferret.WithEngineCloseHook(func() error {
			events.emit(event{Event: "engineClosed"})
			return nil
		}))
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, host.Close()) }()
	wire, err := server.New(host, options...)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	defer listener.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		if controlled {
			if err := events.controls.read(os.Stdin); err != nil {
				fmt.Fprintln(os.Stderr, err)
			}
			cancel()
			_ = events.controls.command("releaseAll", "")
			return
		}
		_, _ = io.Copy(io.Discard, os.Stdin)
		cancel()
	}()
	events.emit(event{Event: "ready", Endpoint: "tcp://" + listener.Addr().String()})
	err = wire.Serve(ctx, listener)
	timeout, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	return errors.Join(err, wire.Shutdown(timeout))
}
