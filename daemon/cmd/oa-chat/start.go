package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
	"golang.org/x/sys/unix"
)

type setupPrompter interface {
	Ask(context.Context, string, string) (string, error)
	Confirm(context.Context, string) (bool, error)
	Printf(string, ...any)
}

// Open the controlling terminal only when a question is necessary. In
// particular, never interpret a piped installation script as spending consent.
type terminalSetupPrompter struct {
	out    io.Writer
	input  *bufio.Reader
	device *setupTerminal
}

// Read directly from a nonblocking descriptor. Darwin can report POLLNVAL for
// /dev/tty; a subsequent blocking read would wait for another complete line
// even after cancellation. Avoid both that read and os.File's runtime poller.
type setupTerminal struct{ fd int }

func (d *setupTerminal) Read(buffer []byte) (int, error) {
	n, err := unix.Read(d.fd, buffer)
	if n < 0 {
		n = 0
	}
	if n == 0 && err == nil {
		err = io.EOF
	}
	return n, err
}

func (p *terminalSetupPrompter) Close() {
	if p.device != nil {
		_ = unix.Close(p.device.fd)
		p.device = nil
	}
}

func (p *terminalSetupPrompter) Printf(format string, args ...any) {
	_, _ = fmt.Fprintf(p.out, format, args...)
}

func (p *terminalSetupPrompter) openTerminal() error {
	if p.input == nil {
		fd, err := unix.Open("/dev/tty", unix.O_RDWR|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err != nil {
			return errors.New("setup needs an interactive terminal; run oa-chat start in a terminal to answer the setup questions")
		}
		device := &setupTerminal{fd: fd}
		p.device, p.input = device, bufio.NewReader(device)
	}
	return nil
}

func (p *terminalSetupPrompter) Secret(ctx context.Context, question string) (string, error) {
	if err := p.openTerminal(); err != nil {
		return "", err
	}
	if p.device == nil {
		return "", errors.New("password entry requires a controlling terminal")
	}
	restore, err := disableTerminalEcho(p.device.fd)
	if err != nil {
		return "", errors.New("could not hide password input")
	}
	defer restore()
	defer p.Printf("\n")
	return p.Ask(ctx, question, "")
}

func (p *terminalSetupPrompter) Ask(ctx context.Context, question, fallback string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := p.openTerminal(); err != nil {
		return "", err
	}
	p.Printf("%s", question)
	if fallback != "" {
		p.Printf(" [%s]", fallback)
	}
	p.Printf(": ")
	var line strings.Builder
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if p.device != nil && p.input.Buffered() == 0 {
			fds := []unix.PollFd{{Fd: int32(p.device.fd), Events: unix.POLLIN}}
			n, err := unix.Poll(fds, 100)
			if errors.Is(err, unix.EINTR) {
				continue
			}
			if err != nil {
				return "", errors.New("could not read setup terminal")
			}
			if n == 0 {
				continue
			}
		}
		b, err := p.input.ReadByte()
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.EAGAIN) || errors.Is(err, unix.EWOULDBLOCK) {
			// Some terminal devices return an immediate poll event while no
			// canonical input is available. Bound retries without busy-spinning.
			timer := time.NewTimer(50 * time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				return "", ctx.Err()
			case <-timer.C:
				continue
			}
		}
		if err != nil {
			return "", errors.New("setup input ended; run oa-chat start again to continue")
		}
		if b == '\n' {
			if err := ctx.Err(); err != nil {
				return "", err
			}
			answer := strings.TrimSpace(line.String())
			if answer == "" {
				answer = fallback
			}
			return answer, nil
		}
		if line.Len() >= 4096 {
			return "", errors.New("setup input is too long")
		}
		line.WriteByte(b)
	}
}

func (p *terminalSetupPrompter) Confirm(ctx context.Context, question string) (bool, error) {
	for {
		answer, err := p.Ask(ctx, question+" (yes/no)", "no")
		if err != nil {
			return false, err
		}
		switch strings.ToLower(answer) {
		case "yes", "y":
			return true, nil
		case "no", "n":
			return false, nil
		default:
			p.Printf("Please enter yes or no.\n")
		}
	}
}

type startOptions struct {
	network, backend, usd, model, listen string
}

func parseStartOptions(args []string) (startOptions, error) {
	var options startOptions
	f := flag.NewFlagSet("start", flag.ContinueOnError)
	f.StringVar(&options.network, "network", "", "network for new setup; must match an existing wallet")
	f.StringVar(&options.backend, "backend", "", "ticket or zkapi (new setup: zkapi; otherwise saved default)")
	f.StringVar(&options.usd, "usd", "", "preferred USD deposit amount; spending still requires confirmation")
	f.StringVar(&options.model, "model", "", "check readiness for this model's automatic request budget")
	f.StringVar(&options.listen, "listen", "", "loopback API address for new setup")
	if err := f.Parse(args); err != nil {
		return options, err
	}
	empty := false
	f.Visit(func(f *flag.Flag) { empty = empty || f.Value.String() == "" })
	if empty || f.NArg() != 0 {
		return options, errors.New("start flags require nonempty values; unexpected arguments are not accepted")
	}
	if options.network != "" && options.network != "mainnet" && options.network != "sepolia" {
		return options, errors.New("network must be mainnet or sepolia")
	}
	if options.backend != "" && options.backend != "ticket" && options.backend != "zkapi" {
		return options, errors.New("backend must be ticket or zkapi")
	}
	if options.usd != "" {
		if _, err := parseFundingAmountForAsset(options.usd, 6, "USD"); err != nil {
			return options, err
		}
	}
	return options, nil
}

func prepareStartConfig(ctx context.Context, dir string, options startOptions, ui setupPrompter) (config.Config, error) {
	if err := ctx.Err(); err != nil {
		return config.Config{}, err
	}
	// Lstat distinguishes absent configuration from invalid files and dangling
	// symlinks. Load errors must never trigger reinitialization of a wallet.
	if err := config.EnsureDir(dir); err != nil {
		return config.Config{}, err
	}
	_, err := os.Lstat(filepath.Join(dir, "config.json"))
	if err == nil {
		c, err := config.Load(dir)
		if err != nil {
			return c, err
		}
		if options.network != "" && options.network != c.ZKAPI.Network {
			return c, fmt.Errorf("this configuration uses %s; use that network or select a separate --config-dir for %s", c.ZKAPI.Network, options.network)
		}
		if options.listen != "" && options.listen != c.Listen {
			return c, errors.New("--listen differs from the saved configuration; reuse its address or choose a separate --config-dir")
		}
		if options.backend != "" {
			c.Backend = options.backend
		}
		ui.Printf("Using configuration: %s\n", dir)
		return c, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return config.Config{}, errors.New("cannot inspect existing configuration; preserve it and check directory permissions")
	}
	for _, name := range []string{"funding", "zkapi", "tickets.json", "management-token"} {
		if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
			return config.Config{}, errors.New("config.json is missing but wallet state exists; restore your configuration backup or use a separate --config-dir")
		}
	}
	c, err := config.Default()
	if err != nil {
		return c, err
	}
	c.Backend = "zkapi"
	if options.backend != "" {
		c.Backend = options.backend
	}
	defaultNetwork := c.ZKAPI.Network
	c.ZKAPI.Network = options.network
	for c.ZKAPI.Network == "" {
		answer, err := ui.Ask(ctx, "Choose network: mainnet (real ETH) or sepolia (test ETH)", defaultNetwork)
		if err != nil {
			return c, err
		}
		switch strings.ToLower(answer) {
		case "mainnet", "sepolia":
			c.ZKAPI.Network = strings.ToLower(answer)
		default:
			ui.Printf("Enter mainnet or sepolia.\n")
		}
	}
	if options.listen != "" {
		c.Listen = options.listen
	}
	if err := ctx.Err(); err != nil {
		return c, err
	}
	if err := config.Init(dir, c); err != nil {
		return c, err
	}
	c, err = config.Load(dir) // Also creates the separate owner-only management credential.
	if err == nil {
		ui.Printf("Created configuration: %s\nBack up this directory to preserve your wallet and recovery state.\n", dir)
	}
	return c, err
}

// Drop routine daemon logs while questions are displayed; enable them once
// setup finishes. Both writes and activation are serialized with the logger.
type setupLogWriter struct {
	mu      sync.Mutex
	out     io.Writer
	enabled bool
}

func (w *setupLogWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.enabled {
		return len(p), nil
	}
	return w.out.Write(p)
}

func (w *setupLogWriter) enable() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.enabled = true
}

type startRuntime struct {
	testnet   func(context.Context, string, config.Config, setupPrompter) error
	active    func(context.Context, config.Config) (config.Config, error)
	probe     func(context.Context, config.Config) (bool, error)
	serve     func(context.Context, string, config.Config, io.Writer) error
	companion func(context.Context, config.Config) error
	fund      func(context.Context, config.Config, string, string, setupPrompter) error
	tickets   func(context.Context, string, config.Config, setupPrompter) error
	interval  time.Duration
	timeout   time.Duration
}

func runGuidedStart(ctx context.Context, dir string, args []string, ui setupPrompter, out io.Writer) error {
	options, err := parseStartOptions(args)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	err = guidedStart(ctx, dir, options, ui, out, startRuntime{
		testnet: prepareSepoliaAccess,
		active:  resolveActiveConfig, probe: probeSetupService, serve: serve, companion: checkSetupCompanion,
		fund: runGuidedFunding, tickets: runGuidedTickets,
		interval: 500 * time.Millisecond, timeout: 90 * time.Second,
	})
	if ctx.Err() != nil {
		ui.Printf("\nStopped. Your saved wallet state is preserved; rerun the same start command to continue.\n")
		return nil
	}
	return err
}

func guidedStart(ctx context.Context, dir string, options startOptions, ui setupPrompter, out io.Writer, runtime startRuntime) (result error) {
	c, err := prepareStartConfig(ctx, dir, options, ui)
	if err != nil {
		return err
	}
	if options.backend == "" && runtime.active != nil {
		checkCtx, checkCancel := context.WithTimeout(ctx, 3*time.Second)
		active, activeErr := runtime.active(checkCtx, c)
		checkCancel()
		if activeErr == nil {
			if active.Backend == "zkapi" && active.ZKAPI.Network != c.ZKAPI.Network {
				return errors.New("the running daemon's network differs from this configuration; preserve the wallet and stop the conflicting service yourself")
			}
			// Match an existing service only in memory. Keep the configured
			// network, wallet identity, and saved default unchanged.
			c.Backend = active.Backend
		}
	}
	if c.Backend == "ticket" && (options.usd != "" || options.model != "") {
		return errors.New("--usd and --model apply to zkapi setup; select --backend zkapi for model-based ETH funding")
	}
	ui.Printf("Mode: %s; network: %s.\n", c.Backend, c.ZKAPI.Network)
	attached, err := runtime.probe(ctx, c)
	if err != nil {
		return err
	}
	life, cancel := context.WithCancel(ctx)
	defer cancel()
	logs := &setupLogWriter{out: out}
	var done chan error
	if attached {
		ui.Printf("Using the compatible daemon already running at http://%s.\n", c.Listen)
	} else {
		if c.Backend == "zkapi" && runtime.testnet != nil {
			if err := runtime.testnet(ctx, dir, c, ui); err != nil {
				return err
			}
		}
		if c.Backend == "zkapi" {
			ui.Printf("Starting the local API and zkAPI companion...\n")
		} else {
			ui.Printf("Starting the local API...\n")
		}
		done = make(chan error, 1)
		go func() {
			done <- runtime.serve(life, dir, c, logs)
			cancel()
		}()
		defer func() {
			cancel()
			if done != nil {
				if err := <-done; err != nil && (result == nil || errors.Is(result, context.Canceled)) {
					result = err
				}
			}
		}()
	}
	readyCtx, readyCancel := context.WithTimeout(life, runtime.timeout)
	defer readyCancel()
	for {
		running, err := runtime.probe(readyCtx, c)
		if err != nil && attached {
			return err
		}
		// The process we own binds before validating companion assets. Until
		// its HTTP handler starts, even authentication probes can time out.
		// Retry during that bounded startup period, but remain strict about a
		// service found by the initial probe or an attached daemon changing.
		if err == nil && running && (c.Backend == "ticket" || runtime.companion(readyCtx, c) == nil) {
			break
		}
		timer := time.NewTimer(runtime.interval)
		select {
		case <-readyCtx.Done():
			timer.Stop()
			if life.Err() != nil {
				return life.Err()
			}
			return errors.New("setup timed out waiting for the local API and companion; check that oa-chat, oa-zkapi, and proving assets are installed together, then rerun start")
		case <-timer.C:
		}
	}
	readyCancel()
	if c.Backend == "zkapi" {
		err = runtime.fund(life, c, options.usd, options.model, ui)
	} else {
		err = runtime.tickets(life, dir, c, ui)
	}
	if err != nil {
		return err
	}
	if err := life.Err(); err != nil {
		return err
	}
	ui.Printf("\nReady for inference.\nOpenAI base URL: http://%s/v1\nGet your local API key: %s --config-dir %s api-key\n", c.Listen, setupExecutable(), shellQuoteSetup(dir))
	if attached {
		ui.Printf("The existing daemon continues running.\n")
		return nil
	}
	ui.Printf("Leave this terminal running. Ctrl+C stops the daemon; rerun the same start command to resume.\n")
	logs.enable()
	result = <-done
	done = nil
	return result
}

func shellQuoteSetup(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func setupExecutable() string {
	executable, err := os.Executable()
	if err != nil {
		return "oa-chat"
	}
	return shellQuoteSetup(executable)
}

func probeSetupService(ctx context.Context, c config.Config) (bool, error) {
	dialer := net.Dialer{Timeout: time.Second}
	connection, err := dialer.DialContext(ctx, "tcp", c.Listen)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, nil
	}
	_ = connection.Close()
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	active, err := resolveActiveConfig(checkCtx, c)
	if err != nil {
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		return false, errors.New("the configured API port is occupied but its daemon could not be authenticated; stop the conflicting service yourself or choose a separate configuration and listen address")
	}
	if active.Backend != c.Backend || (c.Backend == "zkapi" && active.ZKAPI.Network != c.ZKAPI.Network) {
		return false, errors.New("the running daemon uses a different mode or network; stop it yourself and rerun start, or select its mode with --backend")
	}
	return true, nil
}

func checkSetupCompanion(ctx context.Context, c config.Config) error {
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	wallet, err := zkapi.New(zkConfig(c, client))
	if err != nil {
		return err
	}
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	raw, err := wallet.WalletStatus(checkCtx)
	if err != nil {
		return err
	}
	var state struct {
		HasNote *bool `json:"has_note"`
	}
	if json.Unmarshal(raw, &state) != nil || state.HasNote == nil {
		return errors.New("invalid companion wallet status")
	}
	return nil
}

func runGuidedTickets(ctx context.Context, dir string, c config.Config, ui setupPrompter) error {
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	wallet, err := ticketBackend(dir, c, client)
	if err != nil {
		return err
	}
	count, err := wallet.CountContext(ctx)
	if err != nil {
		return err
	}
	for count == 0 {
		ui.Printf("Your ticket wallet is empty. You can import exported tickets or redeem an invitation code from a private file.\n")
		action, err := ui.Ask(ctx, "Add tickets: import or redeem", "import")
		if err != nil {
			return err
		}
		if action != "import" && action != "redeem" {
			ui.Printf("Enter import or redeem.\n")
			continue
		}
		path, err := ui.Ask(ctx, "Path to the private "+map[string]string{"import": "ticket JSON", "redeem": "invitation-code"}[action]+" file", "")
		if err != nil {
			return err
		}
		if strings.HasPrefix(path, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				path = filepath.Join(home, path[2:])
			}
		}
		// Nonblocking open also lets us reject a FIFO without waiting forever
		// before checking that the selected input is a regular file.
		fd, err := unix.Open(path, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NONBLOCK, 0)
		if err != nil {
			return errors.New("cannot open ticket input file; check its path and rerun start")
		}
		file := os.NewFile(uintptr(fd), path)
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() {
			_ = file.Close()
			return errors.New("ticket input must be a regular file")
		}
		if action == "import" {
			_, err = wallet.Import(ctx, file)
		} else {
			var data []byte
			data, err = io.ReadAll(io.LimitReader(file, 1025))
			if err == nil && len(data) > 1024 {
				err = errors.New("invitation-code file is too large")
			}
			if err == nil {
				_, err = wallet.RedeemCode(ctx, strings.TrimSpace(string(data)))
			}
		}
		_ = file.Close()
		if err != nil {
			return err
		}
		count, err = wallet.CountContext(ctx)
		if err != nil {
			return err
		}
	}
	models, err := localRequest(ctx, c, http.MethodGet, "/v1/models")
	if err != nil {
		return errors.New("ticket wallet is present, but model discovery is unavailable; check the service connection and rerun start")
	}
	var catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(models, &catalog) != nil || len(catalog.Data) == 0 {
		return errors.New("no ticket models are available; rerun start when the model service is available")
	}
	for _, model := range catalog.Data {
		if strings.TrimSpace(model.ID) == "" {
			return errors.New("model discovery returned invalid ticket model metadata")
		}
	}
	ui.Printf("Ticket wallet ready: %d tickets available; model discovery checked. Ticket requirements vary by model.\n", count)
	return nil
}
