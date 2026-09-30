package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
)

type configureAction func(context.Context, string, config.Config, string, setupPrompter, io.Writer) error

type configureOptions struct {
	backend, network, listen, relay, binary, proofs string
	usd                                             string
	status, apiKey, edit, menu, requireAPIKey       bool
	fields                                          map[string]bool
}

func parseConfigureOptions(args []string, out io.Writer) (configureOptions, error) {
	var o configureOptions
	f := flag.NewFlagSet("config", flag.ContinueOnError)
	f.SetOutput(out)
	f.StringVar(&o.backend, "backend", "", "saved mode: ticket or zkapi")
	f.StringVar(&o.network, "network", "", "zkAPI network: mainnet or sepolia")
	f.StringVar(&o.listen, "listen", "", "numeric loopback API address and port")
	f.StringVar(&o.relay, "relay-url", "", "optional Wisp relay URL; empty selects direct HTTPS")
	f.StringVar(&o.binary, "zkapi-binary", "", "path to the installed zkAPI companion")
	f.StringVar(&o.proofs, "proof-setup-dir", "", "path to the installed proving assets")
	f.StringVar(&o.usd, "usd", "", "skip the new-deposit USD amount prompt (prompt default: 20; network fees are extra)")
	f.BoolVar(&o.status, "status", false, "show saved configuration status without setup")
	f.BoolVar(&o.apiKey, "api-key", false, "print the local inference API key explicitly")
	f.BoolVar(&o.requireAPIKey, "require-api-key", false, "require a local API key for inference (default: no key required)")
	f.BoolVar(&o.edit, "edit", false, "edit mode, network, listener, and transport interactively")
	f.BoolVar(&o.menu, "menu", false, "open configuration and wallet management actions")
	if err := f.Parse(args); err != nil {
		return o, err
	}
	o.fields = make(map[string]bool)
	invalid := false
	f.Visit(func(field *flag.Flag) {
		if field.Name == "status" || field.Name == "api-key" || field.Name == "edit" || field.Name == "menu" {
			return
		}
		if field.Name != "usd" {
			o.fields[field.Name] = true
		}
		invalid = invalid || (field.Name != "relay-url" && strings.TrimSpace(field.Value.String()) == "")
	})
	if invalid || f.NArg() != 0 {
		return o, errors.New("config flags require nonempty values except --relay-url; unexpected arguments are not accepted")
	}
	selectors := 0
	for _, selected := range []bool{o.status, o.apiKey, o.edit, o.menu} {
		if selected {
			selectors++
		}
	}
	if selectors > 1 || selectors != 0 && (len(o.fields) != 0 || o.usd != "") {
		return o, errors.New("use --status, --api-key, --edit, or --menu by itself, without other configuration options")
	}
	if o.fields["backend"] && o.backend != "ticket" && o.backend != "zkapi" {
		return o, errors.New("backend must be ticket or zkapi")
	}
	if o.fields["network"] && o.network != "mainnet" && o.network != "sepolia" {
		return o, errors.New("network must be mainnet or sepolia")
	}
	if o.usd != "" {
		if _, err := parseFundingAmountForAsset(o.usd, 6, "USD"); err != nil {
			return o, err
		}
		if o.backend == "ticket" {
			return o, errors.New("--usd applies to zkAPI deposits only")
		}
	}
	return o, nil
}

func runConfigure(ctx context.Context, dir string, args []string, ui setupPrompter, out io.Writer) error {
	err := configure(ctx, dir, args, ui, out, nil)
	if ctx.Err() != nil {
		ui.Printf("\nStopped. Your saved configuration and wallet state are preserved; run oa-chat config to continue.\n")
		return nil
	}
	return err
}

func configure(ctx context.Context, dir string, args []string, ui setupPrompter, out io.Writer, action configureAction) error {
	o, err := parseConfigureOptions(args, out)
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	if err != nil {
		return err
	}
	// Tests may supply a side-effect-free action. The production action carries
	// the new-deposit preference without persisting it or changing recovery intent.
	if action == nil {
		action = func(ctx context.Context, dir string, c config.Config, operation string, ui setupPrompter, out io.Writer) error {
			return runConfigActionWithUSD(ctx, dir, c, operation, o.usd, ui, out)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := config.EnsureDir(dir); err != nil {
		return err
	}
	_, err = os.Lstat(filepath.Join(dir, "config.json"))
	if errors.Is(err, os.ErrNotExist) {
		if o.apiKey || o.menu {
			return errors.New("configuration is missing; run oa-chat config to create it")
		}
		ui.Printf("Configuration: not configured.\n")
		if o.status {
			return nil
		}
		for _, name := range []string{"funding", "zkapi", "tickets.json", "management-token"} {
			if _, err := os.Lstat(filepath.Join(dir, name)); !errors.Is(err, os.ErrNotExist) {
				return errors.New("config.json is missing but wallet state exists; restore your configuration backup or use a separate --config-dir")
			}
		}
		c, err := config.Default()
		if err != nil {
			return err
		}
		c.Backend = "zkapi"
		c = applyConfigureOptions(c, o)
		if o.edit {
			c, err = promptConfigure(ctx, c, ui, true)
		}
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := config.Init(dir, c); err != nil {
			return err
		}
		c, err = config.Load(dir)
		if err != nil {
			return err
		}
		ui.Printf("Created private configuration. Back up your configuration directory to preserve both wallets and their recovery state.\n")
		showConfigureSummary(c, ui)
		return action(ctx, dir, c, "setup", ui, out)
	}
	if err != nil {
		return errors.New("cannot inspect configuration; preserve the profile and check its permissions")
	}
	c, err := config.Load(dir)
	if err != nil {
		return err
	}
	if o.apiKey {
		_, err := fmt.Fprintln(out, c.APIKey)
		return err
	}
	showConfigureSummary(c, ui)
	if o.status {
		return nil
	}
	if o.usd != "" && applyConfigureOptions(c, o).Backend != "zkapi" {
		return errors.New("--usd applies to zkAPI deposits only; use config --backend zkapi to select that mode")
	}
	if len(o.fields) != 0 {
		return saveConfiguredSettings(ctx, dir, c, applyConfigureOptions(c, o), ui, out, action)
	}
	if o.edit {
		next, err := promptConfigure(ctx, c, ui, true)
		if err != nil {
			return err
		}
		return saveConfiguredSettings(ctx, dir, c, next, ui, out, action)
	}
	if !o.menu {
		return action(ctx, dir, c, "setup", ui, out)
	}
	for {
		choices := "check setup, edit settings, tickets, withdraw, return public ETH, api-key, or quit"
		sepolia := c.Backend == "zkapi" && c.ZKAPI.Network == "sepolia"
		if sepolia {
			choices = "check setup, edit settings, password, tickets, withdraw, return public ETH, api-key, or quit"
		}
		choice, err := ui.Ask(ctx, "Choose: "+choices, "check")
		if err != nil {
			return err
		}
		switch strings.ToLower(strings.TrimSpace(choice)) {
		case "", "check", "setup":
			return action(ctx, dir, c, "setup", ui, out)
		case "edit":
			next, err := promptConfigure(ctx, c, ui, true)
			if err != nil {
				return err
			}
			return saveConfiguredSettings(ctx, dir, c, next, ui, out, action)
		case "tickets", "withdraw", "return":
			return action(ctx, dir, c, strings.ToLower(strings.TrimSpace(choice)), ui, out)
		case "password":
			if sepolia {
				return action(ctx, dir, c, "password", ui, out)
			}
			ui.Printf("Password configuration applies only to Sepolia zkAPI.\n")
		case "api-key":
			_, err := fmt.Fprintln(out, c.APIKey)
			return err
		case "quit", "q":
			return nil
		default:
			ui.Printf("Choose one of the listed actions.\n")
		}
	}
}

func applyConfigureOptions(c config.Config, o configureOptions) config.Config {
	if o.fields["backend"] {
		c.Backend = o.backend
	}
	if o.fields["network"] {
		c.ZKAPI.Network = o.network
	}
	if o.fields["require-api-key"] {
		c.RequireAPIKey = o.requireAPIKey
	}
	if o.fields["listen"] {
		c.Listen = o.listen
	}
	if o.fields["relay-url"] {
		c.RelayURL = o.relay
	}
	if o.fields["zkapi-binary"] {
		c.ZKAPI.Binary = o.binary
	}
	if o.fields["proof-setup-dir"] {
		c.ZKAPI.ProofSetupDir = o.proofs
	}
	return c
}

func showConfigureSummary(c config.Config, ui setupPrompter) {
	transport := "direct HTTPS"
	if c.RelayURL != "" {
		transport = "Wisp relay enabled"
	}
	ui.Printf("Configuration: saved.\nSaved mode: %s\nzkAPI network: %s\nTransport: %s\n", c.Backend, c.ZKAPI.Network, transport)
	showClientConnection(c, ui)
	ui.Printf("Change settings: oa-chat config --edit\nWallet actions: oa-chat config --menu\nUse the same --config-dir for these commands if set.\n")
}

func saveConfiguredSettings(ctx context.Context, dir string, previous, next config.Config, ui setupPrompter, out io.Writer, action configureAction) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if next != previous {
		if err := config.Update(dir, previous, next); err != nil {
			return err
		}
		if next.ZKAPI.Network != previous.ZKAPI.Network {
			ui.Printf("Selected %s. Your %s wallet and recovery files remain saved separately in this configuration directory.\n", next.ZKAPI.Network, previous.ZKAPI.Network)
		}
		ui.Printf("Saved configuration.\n")
		showConfigureSummary(next, ui)
	}
	return action(ctx, dir, next, "setup", ui, out)
}

func promptConfigure(ctx context.Context, c config.Config, ui setupPrompter, edit bool) (config.Config, error) {
	var err error
	c.Backend, err = configureChoice(ctx, ui, "Choose mode: zkapi (private ETH balance) or ticket", c.Backend, "zkapi", "ticket")
	if err != nil {
		return c, err
	}
	if c.Backend == "zkapi" {
		c.ZKAPI.Network, err = configureChoice(ctx, ui, "Choose network: mainnet (real ETH) or sepolia (test ETH)", c.ZKAPI.Network, "mainnet", "sepolia")
		if err != nil {
			return c, err
		}
	}
	if !edit {
		return c, nil
	}
	for {
		value, err := ui.Ask(ctx, "Local API listen address", c.Listen)
		if err != nil {
			return c, err
		}
		candidate := c
		if strings.TrimSpace(value) != "" {
			candidate.Listen = strings.TrimSpace(value)
		}
		if err := config.Validate(candidate); err != nil {
			ui.Printf("%s\n", err)
			continue
		}
		c = candidate
		break
	}
	for {
		fallback := "direct"
		if c.RelayURL != "" {
			// Relay query parameters can carry credentials. Keep the saved URL
			// out of the prompt just as it is kept out of the status summary.
			fallback = "keep"
		}
		value, err := ui.Ask(ctx, "Transport: direct, keep existing relay, or a Wisp relay URL", fallback)
		if err != nil {
			return c, err
		}
		value = strings.TrimSpace(value)
		if value == "" {
			value = fallback
		}
		candidate := c
		candidate.RelayURL = value
		if strings.EqualFold(value, "direct") {
			candidate.RelayURL = ""
		} else if strings.EqualFold(value, "keep") {
			candidate.RelayURL = c.RelayURL
		}
		if err := config.Validate(candidate); err != nil {
			ui.Printf("Invalid transport setting; enter direct or a valid Wisp relay URL.\n")
			continue
		}
		c = candidate
		break
	}
	return c, nil
}

func configureChoice(ctx context.Context, ui setupPrompter, question, fallback string, choices ...string) (string, error) {
	for {
		answer, err := ui.Ask(ctx, question, fallback)
		if err != nil {
			return "", err
		}
		answer = strings.ToLower(strings.TrimSpace(answer))
		if answer == "" {
			answer = fallback
		}
		for _, choice := range choices {
			if answer == choice {
				return answer, nil
			}
		}
		ui.Printf("Enter %s.\n", strings.Join(choices, " or "))
	}
}
