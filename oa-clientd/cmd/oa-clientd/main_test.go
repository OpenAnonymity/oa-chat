package main

import (
	"bytes"
	"context"
	"errors"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/account"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/oatest"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/profile"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/wallet"
	"github.com/OpenAnonymity/oa-chat/oa-clientd/pkg/server"
)

func imports(t *testing.T, root string) map[string][]string {
	t.Helper()
	found := map[string][]string{}
	fset := token.NewFileSet()
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() || !strings.HasSuffix(path, ".go") {
			return err
		}
		file, err := parser.ParseFile(fset, path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, spec := range file.Imports {
			found[strings.Trim(spec.Path.Value, `"`)] = append(found[strings.Trim(spec.Path.Value, `"`)], path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return found
}

// This module has no path to an Ethereum wallet or payment client: no source
// imports one, and neither go.mod nor go.sum names one, so nothing can link it.
// Other modules may import pkg/; internal/oa stays out of their reach.
func TestModuleCannotReachAPaymentWallet(t *testing.T) {
	forbidden := []string{"github.com/ethereum/", "github.com/OpenAnonymity/zkapi"}
	for path, files := range imports(t, "../..") {
		for _, prefix := range forbidden {
			if strings.HasPrefix(path, prefix) {
				t.Fatalf("imports %s: %v", path, files)
			}
		}
	}
	for _, name := range []string{"../../go.mod", "../../go.sum"} {
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		for _, prefix := range forbidden {
			if strings.Contains(string(data), prefix) {
				t.Fatalf("%s names %s", name, prefix)
			}
		}
	}
}

// Only the account package can name an account route, and it cannot reach the
// redemption route. A single client can't carry both.
func TestAccountAndRedemptionStaySeparate(t *testing.T) {
	const ticketsPkg = "github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/tickets"
	if paths, ok := imports(t, "../../internal/oa/account")[ticketsPkg]; ok {
		t.Fatalf("account imports tickets: %v", paths)
	}
	const accountPkg = "github.com/OpenAnonymity/oa-chat/oa-clientd/internal/oa/account"
	if paths, ok := imports(t, "../../internal/oa/tickets")[accountPkg]; ok {
		t.Fatalf("tickets imports account: %v", paths)
	}
}

func TestVersionAndHelpNeedNoProfile(t *testing.T) {
	t.Setenv("OA_CLIENTD_CONFIG_DIR", filepath.Join(t.TempDir(), "absent"))
	var out bytes.Buffer
	if err := run([]string{"version"}, &out); err != nil || !strings.HasPrefix(out.String(), "oa-clientd ") {
		t.Fatalf("out=%q err=%v", out.String(), err)
	}
	out.Reset()
	if err := run([]string{"--help"}, &out); err != nil || !strings.Contains(out.String(), "never buys") {
		t.Fatalf("out=%q err=%v", out.String(), err)
	}
	if err := run([]string{"withdraw"}, &out); err == nil {
		t.Fatal("zkAPI commands must not exist")
	}
}

func TestCommandsRequireSetup(t *testing.T) {
	dir := oatest.PrivateDir(t)
	var out bytes.Buffer
	for _, command := range []string{"serve", "sync", "status", "login", "logout", "list-models", "config"} {
		err := run([]string{"--config-dir", dir, command}, &out)
		if !errors.Is(err, profile.ErrMissing) {
			t.Fatalf("%s: err = %v", command, err)
		}
	}
}

func stagingProfile(t *testing.T) string {
	t.Helper()
	dir := oatest.PrivateDir(t)
	env, _ := profile.LookupEnvironment("staging")
	config, err := profile.Default(env)
	if err != nil {
		t.Fatal(err)
	}
	if err := profile.Save(dir, config); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestConcurrentSetupsAgreeOnOneDeployment(t *testing.T) {
	dir := filepath.Join(oatest.PrivateDir(t), "new")
	ctx := context.Background()
	first, err := createOrLoadProfile(ctx, dir, "staging")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createOrLoadProfile(ctx, dir, "production"); err == nil {
		t.Fatal("a second setup changed the deployment")
	}
	again, err := createOrLoadProfile(ctx, dir, "")
	if err != nil || again.OrgURL != first.OrgURL || again.APIKey != first.APIKey {
		t.Fatalf("again = %+v err=%v", again.OrgURL, err)
	}
}

func TestSetupRefusesAnotherEnvironmentForAProfile(t *testing.T) {
	dir := stagingProfile(t)
	var out bytes.Buffer
	err := run([]string{"--config-dir", dir, "setup", "--env", "production"}, &out)
	if err == nil || !strings.Contains(err.Error(), "separate --config-dir") {
		t.Fatalf("err = %v", err)
	}
}

func TestConfigShowsNoSecretsAndPersists(t *testing.T) {
	dir := stagingProfile(t)
	var out bytes.Buffer
	if err := run([]string{"--config-dir", dir, "config", "--key-reuse-window-seconds", "0", "--ticket-lease-size", "12", "--web-search", "true"}, &out); err != nil {
		t.Fatal(err)
	}
	config, err := profile.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if config.KeyReuseWindowSeconds != 0 || config.LeaseSize != 12 || !config.WebSearch {
		t.Fatalf("config = %+v", config)
	}
	out.Reset()
	if err := run([]string{"--config-dir", dir, "config"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), config.APIKey) {
		t.Fatal("config output contains the API key")
	}
	if err := run([]string{"--config-dir", dir, "config", "--listen", "0.0.0.0:1"}, &out); err == nil {
		t.Fatal("non-loopback listen accepted")
	}
}

func TestBooleanFlagsApplyIndependently(t *testing.T) {
	for _, c := range []struct {
		args               []string
		requireKey, search bool
	}{
		{[]string{"--require-api-key", "true", "--web-search", "true"}, true, true},
		{[]string{"--require-api-key", "false", "--web-search", "false"}, false, false},
		{[]string{"--require-api-key", "true", "--web-search", "false"}, true, false},
		{[]string{"--require-api-key", "true"}, true, true},
		{[]string{"--web-search", "false"}, false, false},
	} {
		dir := stagingProfile(t)
		var out bytes.Buffer
		if err := run(append([]string{"--config-dir", dir, "config"}, c.args...), &out); err != nil {
			t.Fatalf("%v: %v", c.args, err)
		}
		config, _ := profile.Load(dir)
		if config.RequireAPIKey != c.requireKey || config.WebSearch != c.search {
			t.Errorf("%v: require=%v search=%v", c.args, config.RequireAPIKey, config.WebSearch)
		}
	}
}

func TestRewriterConfigKeepsItsKeyOutOfOutput(t *testing.T) {
	dir := stagingProfile(t)
	t.Setenv("OA_TEST_REWRITER_KEY", "REWRITER-KEY-CANARY")
	var out bytes.Buffer
	if err := run([]string{"--config-dir", dir, "config", "--rewriter-url", "https://rewriter.example/v1", "--rewriter-model", "m", "--rewriter-api-key-env", "OA_TEST_REWRITER_KEY"}, &out); err != nil {
		t.Fatal(err)
	}
	config, _ := profile.Load(dir)
	if !config.Rewriter.Enabled() || config.Rewriter.APIKey != "REWRITER-KEY-CANARY" {
		t.Fatalf("rewriter = %+v", config.Rewriter.Model)
	}
	if !strings.Contains(out.String(), "outside Tor and OA") {
		t.Fatalf("no disclosure: %s", out.String())
	}
	out.Reset()
	if err := run([]string{"--config-dir", dir, "config"}, &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "CANARY") || strings.Contains(out.String(), "rewriter.example") || !strings.Contains(out.String(), "rewriter: true") {
		t.Fatalf("output = %s", out.String())
	}
	if err := run([]string{"--config-dir", dir, "config", "--rewriter-clear"}, &out); err != nil {
		t.Fatal(err)
	}
	config, _ = profile.Load(dir)
	if config.Rewriter.Enabled() || config.Rewriter.APIKey != "" {
		t.Fatal("clear must remove the saved key")
	}
	if err := run([]string{"--config-dir", dir, "config", "--rewriter-url", "http://plain.example", "--rewriter-model", "m"}, &out); err == nil {
		t.Fatal("plain HTTP rewriter accepted")
	}
}

func TestCoverRequiresTor(t *testing.T) {
	dir := stagingProfile(t)
	var out bytes.Buffer
	if err := run([]string{"--config-dir", dir, "config", "--cover-urls", "https://example.com/"}, &out); err == nil {
		t.Fatal("cover without Tor accepted")
	}
}

func TestServeFlags(t *testing.T) {
	dir := stagingProfile(t)
	var out bytes.Buffer
	if err := run([]string{"--config-dir", dir, "serve", "--verbose", "--semi-verbose"}, &out); err == nil || !strings.Contains(err.Error(), "not both") {
		t.Fatalf("err = %v", err)
	}
	if err := run([]string{"--config-dir", dir, "serve", "extra"}, &out); err == nil {
		t.Fatal("extra argument accepted")
	}
}

func TestMCPUsesTheOARouteAndTools(t *testing.T) {
	product := oaMCPProduct()
	if product.DelegatePath != server.OADelegatePath || product.DelegateTool != "oa_delegate" || product.Binary != "oa-clientd" {
		t.Fatalf("product = %+v", product)
	}
	for _, text := range []string{product.Instructions, product.DelegateText, product.ListText, product.ListTitle, product.DelegateTitle} {
		if strings.Contains(strings.ToLower(text), "zkapi") {
			t.Fatalf("zkAPI wording: %s", text)
		}
	}
	var help bytes.Buffer
	if err := runMCP(context.Background(), t.TempDir(), []string{"--help"}, nil, &help); err != nil || !strings.Contains(help.String(), "oa_delegate") {
		t.Fatalf("help=%s err=%v", help.String(), err)
	}
}

func TestStatusIsOfflineAndHidesSecrets(t *testing.T) {
	dir := stagingProfile(t)
	config, _ := profile.Load(dir)
	store, _ := wallet.Open(dir)
	ctx := context.Background()
	session := account.NewSession(dir, config.OrgURL, nil)
	master := []byte(strings.Repeat("m", 32))
	if err := session.Save(ctx, &account.Identity{AccountID: "1234567890123456", AccountKind: "username", Label: "alice\x1b[31m", OrgURL: config.OrgURL, DeviceID: "d", MasterKey: master, Access: "ACCESS-CANARY", Refresh: "REFRESH-CANARY"}); err != nil {
		t.Fatal(err)
	}
	store.Create(ctx, config.OrgURL, "1234567890123456", "d")
	var out bytes.Buffer
	if err := run([]string{"--config-dir", dir, "status"}, &out); err != nil {
		t.Fatal(err)
	}
	text := out.String()
	for _, secret := range []string{"ACCESS-CANARY", "REFRESH-CANARY", string(master), "\x1b"} {
		if strings.Contains(text, secret) {
			t.Fatalf("status leaked %q: %s", secret, text)
		}
	}
	if !strings.Contains(text, "alice") || !strings.Contains(text, "Tickets not reserved by another client: 0 (validity is checked") {
		t.Fatalf("status = %s", text)
	}
}

func TestLogoutWithoutAuthorizationKeepsUnsyncedSpends(t *testing.T) {
	dir := stagingProfile(t)
	config, _ := profile.Load(dir)
	store, _ := wallet.Open(dir)
	ctx := context.Background()
	store.Create(ctx, config.OrgURL, "1234567890123456", strings.Repeat("d", 32))
	store.Update(ctx, func(state *wallet.State) error {
		raw := []byte(`{"finalized_ticket":"a"}`)
		state.Active = []wallet.Ticket{{Token: "a", Raw: raw}}
		_, err := state.Reserve("r", "n", 1, func(wallet.Ticket) bool { return true }, time.Now())
		return err
	})
	var out bytes.Buffer
	err := run([]string{"--config-dir", dir, "logout"}, &out)
	if err == nil || !strings.Contains(err.Error(), "--force") {
		t.Fatalf("err = %v", err)
	}
	if viewErr := store.View(ctx, func(state *wallet.State) error {
		if len(state.Pending) != 1 {
			t.Fatal("wallet was erased")
		}
		return nil
	}); viewErr != nil {
		t.Fatal(viewErr)
	}
	if err := run([]string{"--config-dir", dir, "logout", "--force"}, &out); err != nil {
		t.Fatal(err)
	}
	if viewErr := store.View(ctx, func(*wallet.State) error { return nil }); !errors.Is(viewErr, wallet.ErrNoWallet) {
		t.Fatalf("force left the wallet: %v", viewErr)
	}
}

func TestSecondServeRefusedByProfileLock(t *testing.T) {
	dir := stagingProfile(t)
	parts, err := open(dir)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	// Without credentials serve stops before binding, after taking the lock.
	var out bytes.Buffer
	if err := serve(ctx, dir, parts, &out); !errors.Is(err, account.ErrSignedOut) {
		t.Fatalf("err = %v", err)
	}
}

func TestSyncErrorLinesCarryNoRawError(t *testing.T) {
	raw := errors.New("Post wss://relay?secret=abc: TOKEN")
	if line := syncErrorLine(raw); strings.Contains(line, "secret") || strings.Contains(line, "TOKEN") {
		t.Fatalf("line = %s", line)
	}
	if !strings.Contains(syncErrorLine(account.ErrRevoked), "login") {
		t.Fatal("revocation must say what to do")
	}
}

func TestPrompterShowsFallbackLinkAndCode(t *testing.T) {
	var out bytes.Buffer
	terminalPrompter{out: &out}.Authorize("https://chat/#oa-daemon=x", "ABCD-EF23", false, 10*time.Minute)
	for _, want := range []string{"https://chat/#oa-daemon=x", "ABCD-EF23", "Could not open", "Ctrl+C"} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in %s", want, out.String())
		}
	}
}
