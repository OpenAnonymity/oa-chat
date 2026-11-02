package activity

import (
	"context"
	"fmt"
	"log"
	"strings"
	"unicode/utf8"
)

type Level int

const (
	Normal Level = iota
	SemiVerbose
	Verbose
)

type diagnosticsKey struct{}
type diagnostics struct {
	level  Level
	logger *log.Logger
}

func WithDiagnostics(ctx context.Context, level Level, logger *log.Logger) context.Context {
	return context.WithValue(ctx, diagnosticsKey{}, diagnostics{level, logger})
}
func InheritDiagnostics(ctx, parent context.Context) context.Context {
	d, ok := parent.Value(diagnosticsKey{}).(diagnostics)
	if !ok {
		return ctx
	}
	return context.WithValue(ctx, diagnosticsKey{}, d)
}

func DiagnosticLevel(ctx context.Context) Level {
	d, _ := ctx.Value(diagnosticsKey{}).(diagnostics)
	return d.level
}
func Diagnostic(ctx context.Context, format string, args ...any) {
	d, _ := ctx.Value(diagnosticsKey{}).(diagnostics)
	if d.level != Normal && d.logger != nil {
		d.logger.Print(fmt.Sprintf(format, args...))
	}
}

// Summary retains only the edges, counting Unicode characters incrementally.
// Callers feed complete UTF-8 strings, e.g. decoded message/delta content.
type Summary struct {
	First, Last []rune
	Count       int
}

func (s *Summary) Add(text string) {
	for _, r := range text {
		s.Count++
		if len(s.First) < 32 {
			s.First = append(s.First, r)
		}
		if len(s.Last) == 32 {
			copy(s.Last, s.Last[1:])
			s.Last = s.Last[:31]
		}
		s.Last = append(s.Last, r)
	}
}
func (s *Summary) String() string {
	if s.Count <= 64 && s.Count > 32 {
		// The overlapping portion of the tail must not be duplicated.
		return fmt.Sprintf("%q (%d chars)", string(s.First)+string(s.Last[64-s.Count:]), s.Count)
	}
	if s.Count <= 32 {
		return fmt.Sprintf("%q (%d chars)", string(s.First), s.Count)
	}
	return fmt.Sprintf("%q ... %q (%d chars)", string(s.First), string(s.Last), s.Count)
}
func Message(ctx context.Context, label, text string) {
	if DiagnosticLevel(ctx) == Normal {
		return
	}
	if DiagnosticLevel(ctx) == Verbose {
		// Quote terminal control characters; bound each line, not the message.
		for len(text) > 0 {
			end := min(len(text), 4096)
			for end < len(text) && !utf8.RuneStart(text[end]) {
				end--
			}
			Diagnostic(ctx, "%s %q", label, text[:end])
			text = text[end:]
		}
	} else {
		var s Summary
		s.Add(strings.ToValidUTF8(text, "�"))
		Diagnostic(ctx, "%s %s", label, s.String())
	}
}
