package server

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestRequestLogsContainOnlyAllowlistedMetadata(t *testing.T) {
	for _, test := range []struct {
		name, method, target, want string
	}{
		{"inference", http.MethodPost, "/v1/chat/completions?secret=query", "method=POST route=/v1/chat/completions"},
		{"models", http.MethodGet, "/v1/models?secret=query", "method=GET route=/v1/models"},
		{"unknown method", "SECRET-METHOD", "/v1/chat/completions?capability=query", "method=OTHER route=/v1/chat/completions"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte("response-secret"))
			}), log.New(&output, "", 0))
			r := httptest.NewRequest(test.method, test.target, strings.NewReader("prompt-secret"))
			r.Header.Set("Authorization", "Bearer authorization-secret")
			r.Header.Set("X-OA-Management-Token", "management-secret")
			r.Header.Set("Cookie", "cookie-secret")
			r.RemoteAddr = "address-secret:1234"
			handler.ServeHTTP(httptest.NewRecorder(), r)
			got := output.String()
			for _, want := range []string{"request started " + test.want, "request finished " + test.want + " status=403 duration="} {
				if !strings.Contains(got, want) {
					t.Fatalf("missing %q from %q", want, got)
				}
			}
			for _, secret := range []string{"SECRET-METHOD", "private-secret", "query", "capability", "prompt-secret", "response-secret", "authorization-secret", "management-secret", "cookie-secret", "address-secret"} {
				if strings.Contains(got, secret) {
					t.Fatalf("log exposed private value %q", secret)
				}
			}
		})
	}
}

func TestRequestLogsSkipInternalAndNonInferenceRoutes(t *testing.T) {
	for _, target := range []string{
		"/healthz", "/admin/status", "/admin/funding/address", "/admin/funding/deposit",
		"/admin/funding/quote", "/admin/funding/approve", "/admin/withdrawal",
		"/admin/withdrawal/quote", "/admin/withdrawal/approve", "/admin/return",
		"/admin/return/quote", "/admin/return/approve", "/funding/private-secret",
		"/private-secret", "/v1/chat/completions/private-secret", "/v1/models/private-secret",
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost, "SECRET-METHOD"} {
			t.Run(method+target, func(t *testing.T) {
				var output bytes.Buffer
				handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					w.Header().Set("X-OA-Verification-Status", "verifier-unavailable")
					w.WriteHeader(http.StatusForbidden)
					_, _ = io.WriteString(w, "response-secret")
				}), log.New(&output, "", 0))
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, httptest.NewRequest(method, target+"?secret=query", nil))
				if output.Len() != 0 {
					t.Fatalf("non-inference request produced logs: %q", output.String())
				}
				if w.Code != http.StatusForbidden || w.Body.String() != "response-secret" {
					t.Fatal("log filtering changed the response")
				}
			})
		}
	}
}

func TestRequestLogsPreservePanicsWithoutExposingThem(t *testing.T) {
	for _, value := range []any{"panic-secret", http.ErrAbortHandler} {
		var output bytes.Buffer
		handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			panic(value)
		}), log.New(&output, "", 0))
		var recovered any
		func() {
			defer func() { recovered = recover() }()
			handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
		}()
		if recovered != value {
			t.Fatal("logging changed or swallowed the panic")
		}
		got := output.String()
		if !strings.Contains(got, "request aborted method=POST route=/v1/chat/completions status=200") || strings.Contains(got, "finished") || strings.Contains(got, "panic-secret") || strings.Contains(got, http.ErrAbortHandler.Error()) {
			t.Fatalf("panic not logged safely: %q", got)
		}
	}
}

func TestRequestLogsDistinguishCancellationAndWriteFailure(t *testing.T) {
	for _, test := range []struct {
		name   string
		cancel bool
		writer http.ResponseWriter
	}{
		{"canceled", true, httptest.NewRecorder()},
		{"failed write", false, &failedLogWriter{ResponseRecorder: httptest.NewRecorder()}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = w.Write([]byte("response-secret"))
			}), log.New(&output, "", 0))
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.cancel {
				cancel()
			}
			handler.ServeHTTP(test.writer, httptest.NewRequest(http.MethodGet, "/v1/models", nil).WithContext(ctx))
			got := output.String()
			if !strings.Contains(got, "request aborted") || strings.Contains(got, "request finished") || strings.Contains(got, "secret") {
				t.Fatalf("abort not logged safely: %q", got)
			}
		})
	}
}

type failedLogWriter struct{ *httptest.ResponseRecorder }

func (w *failedLogWriter) Write([]byte) (int, error) {
	return 0, errors.New("write-secret")
}

type deadlineLogWriter struct {
	*httptest.ResponseRecorder
	read, write time.Time
}

func (w *deadlineLogWriter) SetReadDeadline(deadline time.Time) error {
	w.read = deadline
	return nil
}

func (w *deadlineLogWriter) SetWriteDeadline(deadline time.Time) error {
	w.write = deadline
	return nil
}

func TestRequestLogsPreserveResponseControllerAndFlushStatus(t *testing.T) {
	var output bytes.Buffer
	deadline := time.Now().Add(time.Minute)
	w := &deadlineLogWriter{ResponseRecorder: httptest.NewRecorder()}
	handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		control := http.NewResponseController(w)
		if err := control.SetReadDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		if err := control.SetWriteDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		if err := control.Flush(); err != nil {
			t.Fatal(err)
		}
		// A flush commits 200; a later WriteHeader cannot change the result.
		w.WriteHeader(http.StatusBadGateway)
	}), log.New(&output, "", 0))
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil))
	if !w.read.Equal(deadline) || !w.write.Equal(deadline) || !w.Flushed || w.Code != http.StatusOK {
		t.Fatal("logging changed response controller behavior")
	}
	if !strings.Contains(output.String(), "request finished method=POST route=/v1/chat/completions status=200") {
		t.Fatalf("flush committed status lost: %q", output.String())
	}
}

func TestRequestLogsKeepImmediateSSEFlushing(t *testing.T) {
	finish := make(chan struct{})
	defer close(finish)
	handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: first\n\n")
		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		select {
		case <-finish:
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}), log.New(io.Discard, "", 0))
	s := httptest.NewServer(handler)
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := httptest.NewRequest(http.MethodPost, s.URL+"/v1/chat/completions", nil).WithContext(ctx)
	r.RequestURI = ""
	response, err := http.DefaultClient.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("first SSE frame was buffered: %q, %v", line, err)
	}
}

func TestVerifierOutageLogsOnlyFixedWarning(t *testing.T) {
	const warning = "Verification unavailable: inference used an outage-eligible key; this key is not verified"
	for _, test := range []struct {
		name, status string
		wantWarning  bool
	}{
		{"unavailable", "verifier-unavailable", true},
		{"verified", "verified", false},
		{"untrusted status", "verifier-unavailable provider-secret", false},
		{"missing", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			for _, stream := range []bool{false, true} {
				var output bytes.Buffer
				handler := LogRequests(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("X-OA-Verification-Status", test.status)
					w.Header().Set("X-OA-Verification-Detail", "provider-secret prompt=private station=private-station")
					w.WriteHeader(http.StatusOK)
					if stream {
						if err := http.NewResponseController(w).Flush(); err != nil {
							t.Fatal(err)
						}
					}
					_, _ = io.WriteString(w, "response-secret")
				}), log.New(&output, "", 0))
				r := httptest.NewRequest(http.MethodPost, "/v1/chat/completions?secret=private-query", strings.NewReader("prompt-secret"))
				r.Header.Set("X-OA-Verification-Status", "verifier-unavailable")
				handler.ServeHTTP(httptest.NewRecorder(), r)
				got := output.String()
				wantCount := 0
				if test.wantWarning {
					wantCount = 1
				}
				if strings.Count(got, warning) != wantCount {
					t.Fatalf("warning count mismatch: %q", got)
				}
				for _, secret := range []string{"provider-secret", "prompt=private", "private-station", "private-query", "prompt-secret", "response-secret"} {
					if strings.Contains(got, secret) {
						t.Fatalf("verification warning exposed %q", secret)
					}
				}
				if !strings.Contains(got, "request finished method=POST route=/v1/chat/completions status=200") {
					t.Fatal("warning replaced request completion logging")
				}
			}
		})
	}
}
