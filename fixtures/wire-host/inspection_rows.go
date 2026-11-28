package main

import (
	"context"
	"fmt"
	"strconv"
	"sync/atomic"

	"github.com/MontFerret/api/debugger"
	"github.com/MontFerret/ferret/v2/pkg/runtime"
)

// Synthetic safe views used to measure individual child reads behind the released Wire server.
type inspectionRows struct {
	runtime.Value
	shape  string
	length int64
	reads  *atomic.Int64
}

func (p *inspectionRows) DebugInfo() runtime.DebugInfo {
	return runtime.DebugInfo{TypeName: "Rows", Display: "Rows"}
}

func (p *inspectionRows) DebugChildrenInfo() runtime.DebugChildrenInfo {
	empty := runtime.DebugChildView{Known: true}
	known := runtime.DebugChildView{Known: true, Readable: true, Count: p.length}
	unknown := runtime.DebugChildView{Readable: true}
	switch p.shape {
	case "mixed":
		return runtime.DebugChildrenInfo{Named: unknown, Indexed: known}
	case "unreadable":
		return runtime.DebugChildrenInfo{Named: runtime.DebugChildView{}, Indexed: known}
	case "proof":
		return runtime.DebugChildrenInfo{Named: unknown, Indexed: empty}
	case "unknown":
		return runtime.DebugChildrenInfo{Named: empty, Indexed: unknown}
	default:
		return runtime.DebugChildrenInfo{Named: empty, Indexed: known}
	}
}

func (p *inspectionRows) DebugChildAt(ctx context.Context, kind debugger.VariableFilter, pos int64) (string, runtime.Value, bool, error) {
	p.reads.Add(1)
	if err := ctx.Err(); err != nil {
		return "", nil, false, err
	}
	if pos >= p.length {
		return "", nil, false, nil
	}
	key := strconv.FormatInt(pos, 10)
	if kind == debugger.VariableFilterNamed {
		switch {
		case p.shape == "proof" && pos == 99:
			key = "\xff"
		case pos == 1:
			key = "e\u0301😀"
		}
	}
	if pos == 0 {
		return key, runtime.NewArrayOf([]runtime.Value{runtime.Int(7)}), true, nil
	}
	return key, runtime.Int(pos), true, nil
}

func newInspectionRows(ctx context.Context, shape, length runtime.Value, reads *atomic.Int64) (runtime.Value, error) {
	mode, ok := shape.(runtime.String)
	size, err := runtime.ToInt(ctx, length)
	if !ok || err != nil || size < 0 {
		return nil, fmt.Errorf("expected a view name and nonnegative size")
	}
	return &inspectionRows{Value: runtime.True, shape: string(mode), length: int64(size), reads: reads}, nil
}
