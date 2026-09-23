// oa-chat runs in the foreground under launchd/Homebrew services or systemd.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/server"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/ticket"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

var version = "dev"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "oa-chat:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	dir, err := config.DefaultDir()
	if err != nil {
		return err
	}
	global := flag.NewFlagSet("oa-chat", flag.ContinueOnError)
	global.StringVar(&dir, "config-dir", dir, "private configuration and wallet directory")
	global.Usage = help
	if err := global.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	args = global.Args()
	if len(args) == 0 {
		help()
		return nil
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return err
	}
	if args[0] == "version" {
		fmt.Println("oa-chat", version)
		return nil
	}
	if args[0] == "help" {
		help()
		return nil
	}
	if args[0] == "init" {
		return initialize(dir, args[1:])
	}
	c, err := config.Load(dir)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch args[0] {
	case "serve":
		if len(args) != 1 {
			return errors.New("serve accepts no arguments; configure config.json")
		}
		return serve(ctx, dir, c)
	case "api-key":
		if len(args) != 1 {
			return errors.New("api-key accepts no arguments")
		}
		fmt.Println(c.APIKey)
		return nil
	case "status":
		return status(ctx, dir, c)
	case "fund":
		return runFunding(ctx, c, args[1:], os.Stdout)
	case "tickets":
		return tickets(ctx, dir, c, args[1:])
	default:
		return errors.New("unknown command; run oa-chat help")
	}
}

func help() {
	fmt.Fprintln(os.Stderr, `Usage: oa-chat [--config-dir DIR] COMMAND

  init [--backend ticket|zkapi] [--network mainnet|sepolia]
       [--org-url HTTPS_ORIGIN] [--verifier-url HTTPS_ORIGIN]
       [--relay-url WSS_URL] [--listen 127.0.0.1:8787]
       [--zkapi-binary PATH] [--proof-setup-dir PATH]
  serve                  Run the local OpenAI API (foreground service)
  status                 Show service and private wallet readiness
  api-key                Print the local key to configure your client
  tickets import FILE|-  Import OA exported ticket JSON
  tickets redeem [--code-file FILE]  Read shared invite code from stdin/file
  fund                   Show your Ethereum funding address and balances
  fund --amount USDC     Wait for funds and deposit that amount locally
  fund --browser         Open the optional address funding page
  fund --no-open         Print the optional funding page URL
  version

OpenAI base URL: http://127.0.0.1:8787/v1
Config: OA_CHAT_CONFIG_DIR or the OS user config directory / oa-chat.
No prompts or responses are stored by the daemon. The connected UI may store them.
Ethereum mainnet is the default; Sepolia requires --network sepolia at init.`)
}

func initialize(dir string, args []string) error {
	c, err := config.Default()
	if err != nil {
		return err
	}
	f := flag.NewFlagSet("init", flag.ContinueOnError)
	f.StringVar(&c.Backend, "backend", c.Backend, "ticket or zkapi")
	f.StringVar(&c.ZKAPI.Network, "network", c.ZKAPI.Network, "mainnet or sepolia")
	f.StringVar(&c.OrgURL, "org-url", c.OrgURL, "ticket organization HTTPS origin")
	f.StringVar(&c.VerifierURL, "verifier-url", c.VerifierURL, "verifier HTTPS origin")
	f.StringVar(&c.RelayURL, "relay-url", c.RelayURL, "encrypted Wisp relay")
	f.StringVar(&c.Listen, "listen", c.Listen, "loopback IP:port")
	f.StringVar(&c.ZKAPI.Binary, "zkapi-binary", "", "path to oa-zkapi wallet/prover")
	f.StringVar(&c.ZKAPI.ProofSetupDir, "proof-setup-dir", "", "verified deployed circuit proving assets")
	if err := f.Parse(args); err != nil {
		return err
	}
	if f.NArg() != 0 {
		return errors.New("unexpected init arguments")
	}
	if err := config.Init(dir, c); err != nil {
		return err
	}
	fmt.Printf("Initialized %s\nAPI base: http://%s/v1\nUse oa-chat api-key to configure your client's bearer key.\n", filepath.Join(dir, "config.json"), c.Listen)
	return nil
}

func ticketBackend(dir string, c config.Config, client *http.Client) (*ticket.Backend, error) {
	return ticket.New(ticket.Config{OrgURL: c.OrgURL, VerifierURL: c.VerifierURL, WalletPath: filepath.Join(dir, "tickets.json"), Client: client})
}
func zkConfig(c config.Config, client *http.Client) zkapi.Config {
	return zkapi.Config{ClientURL: c.ZKAPI.ClientURL, BridgeToken: c.ZKAPI.BridgeToken, Network: c.ZKAPI.Network, HTTPClient: client}
}

type ticketInference struct {
	wallet *ticket.Backend
	client *http.Client
}

type zkInference struct{ *zkapi.Client }

func (z zkInference) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	response, err := z.Client.Complete(ctx, body)
	var remote *zkapi.Error
	if errors.As(err, &remote) {
		switch remote.Status {
		case http.StatusPaymentRequired:
			return nil, &server.BackendError{Status: 402, Code: "funding_required", Message: "The private balance needs funding. Run oa-chat fund."}
		case http.StatusConflict:
			return nil, &server.BackendError{Status: 409, Code: "settlement_pending", Message: "The previous anonymous lease is settling. Retry after settlement; a provider key is never reused across API requests."}
		}
	}
	return response, err
}

func (t *ticketInference) Models(ctx context.Context) (json.RawMessage, error) {
	return t.wallet.Models(ctx)
}
func (t *ticketInference) Complete(ctx context.Context, body json.RawMessage) (*http.Response, error) {
	var request struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &request) != nil {
		return nil, errors.New("invalid request")
	}
	key, err := t.wallet.Acquire(ctx, request.Model)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "https://openrouter.ai/api/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+key.Key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("User-Agent", "OA-Chat/1")
	return t.client.Do(req)
}

func serve(ctx context.Context, dir string, c config.Config) error {
	lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("an OA Chat daemon is already using this config directory")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", c.Listen)
	if err != nil {
		return errors.New("could not bind local API address; check for an existing service")
	}
	defer listener.Close()
	life, cancel := context.WithCancel(ctx)
	defer cancel()
	var backend server.Backend
	var funding *zkapi.FundingHandler
	var childDone chan error
	if c.Backend == "ticket" {
		wallet, err := ticketBackend(dir, c, client)
		if err != nil {
			return err
		}
		backend = &ticketInference{wallet, client}
	} else {
		zc := zkConfig(c, client)
		wallet, err := zkapi.New(zc)
		if err != nil {
			return err
		}
		if !c.ZKAPI.ExternalCompanion {
			proxy, err := relay.StartConnectProxy(life, c.RelayURL)
			if err != nil {
				return err
			}
			defer proxy.Close()
			cmd, err := zkapi.CompanionCommand(life, zc, zkapi.CompanionConfig{Binary: c.ZKAPI.Binary, SetupDir: c.ZKAPI.ProofSetupDir, StateDir: filepath.Join(dir, "zkapi"), VerifierURL: c.VerifierURL, ProxyURL: proxy.URL})
			if err != nil {
				return err
			}
			// The companion may emit wallet/proof details. Inherit no verbose
			// output into system service logs; readiness is checked by policy API.
			cmd.Stdout = io.Discard
			cmd.Stderr = io.Discard
			cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
			cmd.WaitDelay = 5 * time.Second
			if err := cmd.Start(); err != nil {
				return errors.New("failed to start zkAPI companion")
			}
			childDone = make(chan error, 1)
			go func() { childDone <- cmd.Wait(); close(childDone) }()
			defer func() {
				cancel()
				select {
				case <-childDone:
				case <-time.After(7 * time.Second):
					_ = cmd.Process.Kill()
				}
			}()
		}
		backend = zkInference{wallet}
		funding, err = zkapi.NewFundingHandler(wallet, "http://"+c.Listen, filepath.Join(dir, "funding"))
		if err != nil {
			return err
		}
	}
	api, err := server.New(backend, c.APIKey, c.Concurrency)
	if err != nil {
		return err
	}
	if funding != nil {
		// server.API enforces local bearer authentication and rejects browser
		// origins before dispatching these management operations.
		api.Admin = http.HandlerFunc(funding.ServeAdminHTTP)
	}
	mux := http.NewServeMux()
	mux.Handle("/", api)
	if funding != nil {
		mux.Handle("/funding", funding)
		mux.Handle("/funding/", funding)
	}
	httpServer := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10, ErrorLog: log.New(io.Discard, "", 0), BaseContext: func(net.Listener) context.Context { return life }}
	serverDone := make(chan error, 1)
	go func() { serverDone <- httpServer.Serve(listener) }()
	fmt.Printf("OA Chat %s listening at http://%s/v1 (%s); encrypted relay required\n", version, c.Listen, c.Backend)
	var result error
	select {
	case <-ctx.Done():
	case err := <-serverDone:
		if !errors.Is(err, http.ErrServerClosed) {
			result = errors.New("local API server stopped unexpectedly")
		}
	case <-childDone:
		result = errors.New("zkAPI companion stopped; check its installation, proving setup, and deployment availability")
	}
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		_ = httpServer.Close()
	}
	return result
}

func tickets(ctx context.Context, dir string, c config.Config, args []string) error {
	if len(args) == 0 {
		return errors.New("use tickets import FILE or tickets redeem")
	}
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	wallet, err := ticketBackend(dir, c, client)
	if err != nil {
		return err
	}
	var count int
	switch args[0] {
	case "import":
		if len(args) != 2 {
			return errors.New("use tickets import FILE (or - for stdin)")
		}
		var reader io.Reader = os.Stdin
		if args[1] != "-" {
			file, err := os.Open(args[1])
			if err != nil {
				return errors.New("cannot open ticket file")
			}
			defer file.Close()
			reader = file
		}
		count, err = wallet.Import(ctx, reader)
	case "redeem":
		f := flag.NewFlagSet("tickets redeem", flag.ContinueOnError)
		codeFile := f.String("code-file", "", "private file containing OA shared invitation code")
		if err := f.Parse(args[1:]); err != nil {
			return err
		}
		if f.NArg() != 0 {
			return errors.New("read invite codes from stdin or --code-file to keep them out of command history")
		}
		var data []byte
		if *codeFile != "" {
			file, e := os.Open(*codeFile)
			if e != nil {
				return errors.New("cannot open invite-code file")
			}
			defer file.Close()
			data, err = io.ReadAll(io.LimitReader(file, 1025))
		} else {
			fmt.Fprintln(os.Stderr, "Paste the OA shared invite code, then end input (Ctrl-D):")
			data, err = io.ReadAll(io.LimitReader(os.Stdin, 1025))
		}
		if err != nil || len(data) > 1024 {
			return errors.New("invalid invitation code input")
		}
		count, err = wallet.RedeemCode(ctx, strings.TrimSpace(string(data)))
	default:
		return errors.New("use tickets import FILE or tickets redeem")
	}
	if err != nil {
		return err
	}
	fmt.Printf("Imported %d inference tickets.\n", count)
	return nil
}

func status(ctx context.Context, dir string, c config.Config) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := map[string]any{"backend": c.Backend, "api_base": "http://" + c.Listen + "/v1", "relay_required": true}
	_, err := localRequest(ctx, c, "GET", "/healthz")
	result["service_running"] = err == nil
	client, _ := relay.NewClient(c.RelayURL)
	if c.Backend == "ticket" {
		wallet, err := ticketBackend(dir, c, client)
		if err != nil {
			return err
		}
		count, err := wallet.CountContext(ctx)
		if err != nil {
			return err
		}
		result["tickets"] = count
	} else {
		result["network"] = c.ZKAPI.Network
		wallet, err := zkapi.New(zkConfig(c, client))
		if err != nil {
			return err
		}
		data, err := wallet.WalletStatus(ctx)
		result["companion_ready"] = err == nil
		if err == nil {
			var state struct {
				HasNote        bool `json:"has_note"`
				PendingRequest bool `json:"pending_request"`
				Note           struct {
					CurrentBalance any `json:"current_balance"`
				} `json:"note"`
			}
			if json.Unmarshal(data, &state) == nil {
				result["funded"] = state.HasNote
				result["private_balance"] = state.Note.CurrentBalance
				result["pending_settlement"] = state.PendingRequest
			}
		}
	}
	e := json.NewEncoder(os.Stdout)
	e.SetIndent("", "  ")
	return e.Encode(result)
}

func localRequest(ctx context.Context, c config.Config, method, path string) ([]byte, error) {
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	r, err := http.NewRequestWithContext(ctx, method, "http://"+c.Listen+path, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set("Authorization", "Bearer "+c.APIKey)
	resp, err := client.Do(r)
	if err != nil {
		return nil, errors.New("local service is unavailable; start it with Homebrew services, systemd, or oa-chat serve")
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, errors.New("local management request failed")
	}
	return io.ReadAll(io.LimitReader(resp.Body, 1<<20))
}

func openBrowser(url string) error {
	command := "xdg-open"
	if runtime.GOOS == "darwin" {
		command = "open"
	}
	cmd := exec.Command(command, url)
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	return cmd.Run()
}
