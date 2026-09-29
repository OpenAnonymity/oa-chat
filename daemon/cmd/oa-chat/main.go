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
	"os/signal"
	"path/filepath"
	"reflect"
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
	showVersion := global.Bool("version", false, "print version")
	global.Usage = help
	if err := global.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}
	if *showVersion {
		fmt.Println("oa-chat", version)
		return nil
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
	if args[0] == "config" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		ui := &terminalSetupPrompter{out: os.Stdout}
		defer ui.Close()
		return runConfigure(ctx, dir, args[1:], ui, os.Stdout)
	}
	// Legacy entry points remain callable for existing scripts, but are not
	// part of the user-facing command surface.
	if args[0] == "init" {
		return initialize(dir, args[1:])
	}
	if args[0] == "start" {
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		ui := &terminalSetupPrompter{out: os.Stdout}
		defer ui.Close()
		return runGuidedStart(ctx, dir, args[1:], ui, os.Stdout)
	}
	if args[0] == "serve" && len(args) == 2 && (args[1] == "--help" || args[1] == "-h") {
		fmt.Println("Usage: oa-chat serve [--backend ticket|zkapi]\nRun the saved configuration. Run oa-chat config to configure missing prerequisites.")
		return nil
	}
	c, err := config.Load(dir)
	if err != nil {
		return configurationRequired(err)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	switch args[0] {
	case "serve":
		expected := c
		c, err = serveConfig(c, args[1:])
		if err != nil {
			return err
		}
		return runConfiguredServe(ctx, dir, c, expected, os.Stdout)
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
	case "withdraw":
		return runWithdrawal(ctx, c, args[1:], os.Stdout)
	case "tickets":
		return tickets(ctx, dir, c, args[1:])
	default:
		return errors.New("unknown command; use oa-chat config or oa-chat serve (--help for usage)")
	}
}

func help() {
	fmt.Fprintln(os.Stderr, `Usage: oa-chat [--config-dir DIR] COMMAND

  config                 Show status, configure or edit settings, and prepare the wallet
  serve [--backend ticket|zkapi]
                         Run inference using the saved configuration

Run oa-chat config --help for configuration options.
Run oa-chat --version to show the installed version.
Config: OA_CHAT_CONFIG_DIR or the OS user config directory / oa-chat.
Mainnet and Sepolia are available for zkAPI; both wallets are preserved.
The network proxy is off by default. No prompts or responses are stored.`)
}

func initialize(dir string, args []string) error {
	c, err := config.Default()
	if err != nil {
		return err
	}
	f := flag.NewFlagSet("init", flag.ContinueOnError)
	f.StringVar(&c.Backend, "backend", c.Backend, "default serve mode: ticket or zkapi (both wallets are configured)")
	f.StringVar(&c.ZKAPI.Network, "network", c.ZKAPI.Network, "mainnet or sepolia")
	f.StringVar(&c.OrgURL, "org-url", c.OrgURL, "ticket organization HTTPS origin")
	f.StringVar(&c.VerifierURL, "verifier-url", c.VerifierURL, "verifier HTTPS origin")
	f.StringVar(&c.RelayURL, "relay-url", c.RelayURL, "opt into an encrypted Wisp relay (default: direct HTTPS)")
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
	fmt.Printf("Initialized ticket and zkAPI configuration at %s\nAPI base: http://%s/v1\nRun oa-chat serve --backend ticket or oa-chat serve --backend zkapi.\nUse oa-chat api-key to configure your client's bearer key.\n", filepath.Join(dir, "config.json"), c.Listen)
	return nil
}

// Selecting a running mode never rewrites either wallet or its saved default.
func serveConfig(c config.Config, args []string) (config.Config, error) {
	f := flag.NewFlagSet("serve", flag.ContinueOnError)
	f.StringVar(&c.Backend, "backend", c.Backend, "ticket or zkapi (default: saved backend)")
	if err := f.Parse(args); err != nil {
		return config.Config{}, err
	}
	if f.NArg() != 0 {
		return config.Config{}, errors.New("unexpected serve arguments; use --backend ticket or --backend zkapi")
	}
	if err := config.Validate(c); err != nil {
		return config.Config{}, err
	}
	return c, nil
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
		switch remote.Code {
		case "invalid_model":
			return nil, &server.BackendError{Status: 400, Code: "invalid_model", Message: "Select a model from /v1/models."}
		case "model_budget_unavailable":
			return nil, &server.BackendError{Status: 400, Code: "model_budget_unavailable", Message: "The model is unavailable or has no reviewed request budget. Select a model from /v1/models."}
		case "model_policy_unavailable":
			return nil, &server.BackendError{Status: 502, Code: "model_policy_unavailable", Message: "The current model policy could not be loaded. Retry when the model service is available."}
		}
		switch remote.Status {
		case http.StatusPaymentRequired:
			return nil, &server.BackendError{Status: 402, Code: "funding_required", Message: "The private balance needs funding. Run oa-chat config to add funding."}
		case http.StatusConflict:
			if remote.Code == "withdrawal_pending" || remote.Code == "withdrawal_conflict" {
				return nil, &server.BackendError{Status: 409, Code: "withdrawal_pending", Message: "The private balance is reserved for withdrawal. Run oa-chat config and choose withdraw to recover the saved destination."}
			}
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
	response, err := t.client.Do(req)
	if response != nil {
		response.Header.Del("X-OA-Verification-Status")
		response.Header.Del("X-OA-Verification-Detail")
		response.Header.Set("X-OA-Verification-Status", key.VerificationStatus)
		if key.VerificationStatus == "verifier-unavailable" {
			response.Header.Set("X-OA-Verification-Detail", key.VerificationDetail)
		}
	}
	return response, err
}

func serve(ctx context.Context, dir string, c config.Config, out io.Writer) error {
	return serveSnapshot(ctx, dir, c, c, out)
}

func serveSnapshot(ctx context.Context, dir string, c, expected config.Config, out io.Writer) error {
	logger := log.New(out, "oa-chat ", log.LstdFlags)
	logger.Print("Starting local API service")
	lock, err := os.OpenFile(filepath.Join(dir, "daemon.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return errors.New("an OA Chat daemon is already using this config directory")
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	// Configuration may have been edited after command dispatch but before
	// acquiring the service lock. Never start with that stale snapshot.
	saved, err := config.Load(dir)
	if err != nil {
		return configurationRequired(err)
	}
	if !reflect.DeepEqual(saved, expected) {
		return errors.New("configuration changed before startup; run oa-chat config to review it, then retry serve")
	}
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", c.Listen)
	if err != nil {
		return errors.New("could not bind local API address; check for an existing service")
	}
	defer listener.Close()
	c.Listen = listener.Addr().String()
	life, cancel := context.WithCancel(ctx)
	defer cancel()
	var backend server.Backend
	var funding *zkapi.FundingHandler
	var childDone chan error
	var readiness func(context.Context) string
	if c.Backend == "ticket" {
		wallet, err := ticketBackend(dir, c, client)
		if err != nil {
			return err
		}
		backend = &ticketInference{wallet, client}
		readiness = ticketReadiness(wallet)
	} else {
		zc := zkConfig(c, client)
		wallet, err := zkapi.New(zc)
		if err != nil {
			return err
		}
		if !c.ZKAPI.ExternalCompanion {
			logger.Print("Starting zkAPI companion")
			// Keep the local HTTPS-only bridge in both routing modes so the
			// companion cannot follow a redirect to plaintext HTTP.
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
		readiness = zkReadiness(wallet)
		funding, err = zkapi.NewFundingHandler(wallet, "http://"+c.Listen, filepath.Join(dir, "funding"))
		if err != nil {
			return err
		}
	}
	api, err := server.New(backend, c.APIKey, c.Concurrency)
	if err != nil {
		return err
	}
	api.Status = server.ServiceStatus{Backend: c.Backend}
	if c.Backend == "zkapi" {
		api.Status.Network = c.ZKAPI.Network
		api.Status.RequestBudgetPolicy = "model"
	}
	if funding != nil {
		// server.API rejects browser origins and requires both the local bearer
		// and owner-only credential before dispatching any wallet operation.
		api.ManagementToken = c.ManagementToken
		api.Admin = http.HandlerFunc(funding.ServeAdminHTTP)
	}
	httpServer := &http.Server{Handler: server.LogRequests(api, logger), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: time.Minute, MaxHeaderBytes: 32 << 10, ErrorLog: log.New(io.Discard, "", 0), BaseContext: func(net.Listener) context.Context { return life }}
	serverDone := make(chan error, 1)
	go func() { serverDone <- httpServer.Serve(listener) }()
	transport := "direct HTTPS (network proxy off)"
	if c.RelayURL != "" {
		transport = "encrypted relay required"
	}
	logger.Printf("OA Chat %s listening at http://%s/v1 (%s); %s", version, c.Listen, c.Backend, transport)
	if c.Backend == "zkapi" {
		logger.Printf("zkAPI network: %s", c.ZKAPI.Network)
	}
	logger.Print("Use oa-chat config --api-key to configure your client; Ctrl+C stops the service")
	statusDone := make(chan struct{})
	go func() {
		defer close(statusDone)
		monitorReadiness(life, logger, readiness, 5*time.Second)
	}()
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
	if result != nil {
		// These lifecycle errors are fixed local messages, never raw child output.
		logger.Printf("ERROR %s", result)
	}
	logger.Print("Stopping local API service")
	cancel()
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		_ = httpServer.Close()
	}
	<-statusDone
	logger.Print("Local API service stopped")
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
	result := map[string]any{"default_backend": c.Backend, "api_base": "http://" + c.Listen + "/v1", "relay_required": c.RelayURL != ""}
	active, err := resolveActiveConfig(ctx, c)
	result["service_running"] = err == nil
	if err == nil {
		c = active
	} else if _, healthErr := localRequest(ctx, c, "GET", "/healthz"); healthErr == nil {
		return errors.New("local service is running but its active mode could not be authenticated; restart it with the current client and configuration")
	}
	result["backend"] = c.Backend
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
		result["billing_asset"] = "native_eth"
		result["billing_unit"] = "gwei"
		result["request_budget_policy"] = "model"
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

// Management commands use the authenticated running mode, which may differ
// from config.json's default. This copy does not migrate or modify wallet state.
func resolveActiveConfig(ctx context.Context, c config.Config) (config.Config, error) {
	data, err := localRequest(ctx, c, http.MethodGet, "/admin/status")
	if err != nil {
		return config.Config{}, err
	}
	var active server.ServiceStatus
	if json.Unmarshal(data, &active) != nil ||
		(active.Backend != "ticket" && active.Backend != "zkapi") ||
		(active.Backend == "zkapi" && active.Network != "mainnet" && active.Network != "sepolia") ||
		(active.Backend == "ticket" && active.Network != "") {
		return config.Config{}, errors.New("local service returned invalid active-mode metadata; restart it with the current client")
	}
	c.Backend = active.Backend
	if active.Backend == "zkapi" {
		c.ZKAPI.Network = active.Network
	}
	return c, nil
}

func localRequest(ctx context.Context, c config.Config, method, path string) ([]byte, error) {
	client := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
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
