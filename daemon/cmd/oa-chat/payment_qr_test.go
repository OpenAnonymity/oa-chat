package main

import (
	"bytes"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
	qrcode "github.com/skip2/go-qrcode"
)

func paymentQRTestQuote() zkapi.AddressPaymentQuote {
	q := paymentTestQuote("deposit")
	q.BalanceWei = "1"
	q.ShortfallWei = "750001000024999"
	q.RecommendedTopUpWei = "750001000029999"
	return q
}

func TestPaymentRequestURI(t *testing.T) {
	for _, chain := range []uint64{1, 11155111} {
		q := paymentQRTestQuote()
		q.ChainID = chain
		if chain == 11155111 {
			q.Contract = "0x999F40773e47f7e07f435C0CC69225c409B64329"
			q.DeploymentID = "zkapi-native-eth-sepolia-note-bound-v1-fresh-20260928"
		}
		uri, err := paymentRequestURI(q)
		want := "ethereum:" + q.Address + "@" + new(big.Int).SetUint64(chain).String() + "?value=750001000029999"
		if err != nil || uri != want {
			t.Fatalf("chain %d: got %q, %v; want %q", chain, uri, err, want)
		}
	}
}

func TestPaymentRequestURIRejectsMismatchedQuote(t *testing.T) {
	for name, mutate := range map[string]func(*zkapi.AddressPaymentQuote){
		"wrong kind":           func(q *zkapi.AddressPaymentQuote) { q.Kind = "withdrawal" },
		"unsupported chain":    func(q *zkapi.AddressPaymentQuote) { q.ChainID = 10 },
		"deployment chain":     func(q *zkapi.AddressPaymentQuote) { q.ChainID = 11155111 },
		"unknown deployment":   func(q *zkapi.AddressPaymentQuote) { q.DeploymentID = "unknown" },
		"vault recipient":      func(q *zkapi.AddressPaymentQuote) { q.Address = q.Contract },
		"bad address":          func(q *zkapi.AddressPaymentQuote) { q.Address += "?value=1" },
		"zero address":         func(q *zkapi.AddressPaymentQuote) { q.Address = "0x" + strings.Repeat("0", 40) },
		"destination override": func(q *zkapi.AddressPaymentQuote) { q.Destination = q.Address },
		"no principal":         func(q *zkapi.AddressPaymentQuote) { q.Amount = 0 },
		"principal units":      func(q *zkapi.AddressPaymentQuote) { q.Amount++ },
		"negative amount":      func(q *zkapi.AddressPaymentQuote) { q.RecommendedTopUpWei = "-1" },
		"signed amount":        func(q *zkapi.AddressPaymentQuote) { q.RecommendedTopUpWei = "+1" },
		"fractional amount":    func(q *zkapi.AddressPaymentQuote) { q.RecommendedTopUpWei = "0.01" },
		"exponent amount":      func(q *zkapi.AddressPaymentQuote) { q.RecommendedTopUpWei = "1e18" },
		"oversized amount": func(q *zkapi.AddressPaymentQuote) {
			q.RecommendedTopUpWei = new(big.Int).Lsh(big.NewInt(1), 256).String()
		},
		"required total":    func(q *zkapi.AddressPaymentQuote) { q.RequiredTotalWei = "1" },
		"recommended total": func(q *zkapi.AddressPaymentQuote) { q.RecommendedTotalWei = "1" },
		"fee reserve":       func(q *zkapi.AddressPaymentQuote) { q.FeeReserveWei = "1" },
		"fee buffer":        func(q *zkapi.AddressPaymentQuote) { q.FeeBufferWei = "1" },
		"shortfall":         func(q *zkapi.AddressPaymentQuote) { q.ShortfallWei = "1" },
		"top up":            func(q *zkapi.AddressPaymentQuote) { q.RecommendedTopUpWei = q.PrincipalWei },
		"balance":           func(q *zkapi.AddressPaymentQuote) { q.BalanceWei = "0" },
	} {
		t.Run(name, func(t *testing.T) {
			q := paymentQRTestQuote()
			mutate(&q)
			var out bytes.Buffer
			if err := printSetupPaymentQR(&out, q); err == nil || out.Len() != 0 {
				t.Fatalf("invalid quote produced a payment request: err=%v output=%q", err, out.String())
			}
		})
	}
}

func TestPaymentRequestURIOmitsUnneededPayments(t *testing.T) {
	for _, balance := range []string{"750001000025000", "750001000030000", "1000000000000000"} {
		q := paymentTestQuote("deposit")
		q.BalanceWei = balance
		remaining := new(big.Int).Sub(big.NewInt(750001000030000), mustPaymentQRInt(t, balance))
		if remaining.Sign() < 0 {
			remaining.SetInt64(0)
		}
		q.RecommendedTopUpWei = remaining.String()
		var out bytes.Buffer
		if err := printSetupPaymentQR(&out, q); err != nil || out.Len() != 0 {
			t.Fatalf("balance %s produced a payment request: err=%v output=%q", balance, err, out.String())
		}
	}
}

func mustPaymentQRInt(t *testing.T, input string) *big.Int {
	t.Helper()
	value, ok := new(big.Int).SetString(input, 10)
	if !ok {
		t.Fatal("invalid fixture integer")
	}
	return value
}

func TestPrintSetupPaymentQR(t *testing.T) {
	q := paymentQRTestQuote()
	q.Commitment = "private-note-commitment"
	var out bytes.Buffer
	if err := printSetupPaymentQR(&out, q); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"Network: Ethereum Mainnet", "Send: 0.000750001000029999 ETH", "To: " + q.Address, "Payment URI: ethereum:" + q.Address + "@1?value=750001000029999", paymentQRColors, paymentQRReset} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q from payment instructions", want)
		}
	}
	if strings.Contains(out.String(), q.Contract) || strings.Contains(out.String(), q.Commitment) {
		t.Fatal("payment instructions exposed a vault recipient or note commitment")
	}
	if err := printSetupPaymentQR(paymentQRFailWriter{}, q); err == nil {
		t.Fatal("output error was ignored")
	}
}

func TestPaymentQRMaximumAmountFitsTerminal(t *testing.T) {
	q := paymentQRTestQuote()
	reserve := new(big.Int).Lsh(big.NewInt(1), 255)
	q.FeeReserveWei = reserve.String()
	q.FeeBufferWei = new(big.Int).Sub(reserve, mustPaymentQRInt(t, q.RequiredFeeWei)).String()
	recommended := new(big.Int).Add(reserve, mustPaymentQRInt(t, q.PrincipalWei))
	q.RecommendedTotalWei = recommended.String()
	q.RecommendedTopUpWei = new(big.Int).Sub(recommended, big.NewInt(1)).String()
	var out bytes.Buffer
	if err := printSetupPaymentQR(&out, q); err != nil {
		t.Fatal(err)
	}
	for _, row := range strings.Split(out.String(), "\n") {
		if strings.HasPrefix(row, paymentQRColors) {
			cells := []rune(strings.TrimSuffix(strings.TrimPrefix(row, paymentQRColors), paymentQRReset))
			if len(cells) > 79 {
				t.Fatalf("large integer wei value created a %d-column QR", len(cells))
			}
		}
	}
}

type paymentQRFailWriter struct{}

func (paymentQRFailWriter) Write([]byte) (int, error) { return 0, errors.New("closed") }

func TestTerminalPaymentQRPreservesModulesAndQuietZone(t *testing.T) {
	uri, err := paymentRequestURI(paymentQRTestQuote())
	if err != nil {
		t.Fatal(err)
	}
	code, err := qrcode.New(uri, qrcode.Medium)
	if err != nil {
		t.Fatal(err)
	}
	bitmap := code.Bitmap()
	rows := strings.Split(strings.TrimSuffix(terminalPaymentQR(bitmap), "\n"), "\n")
	if len(rows) != (len(bitmap)+1)/2 {
		t.Fatalf("wrong half-block row count: %d", len(rows))
	}
	for y, row := range rows {
		if !strings.HasPrefix(row, paymentQRColors) || !strings.HasSuffix(row, paymentQRReset) {
			t.Fatal("QR row does not explicitly set and reset black-on-white colors")
		}
		cells := []rune(strings.TrimSuffix(strings.TrimPrefix(row, paymentQRColors), paymentQRReset))
		if len(cells) != len(bitmap) || len(cells) > 79 {
			t.Fatalf("QR width %d would crop or wrap modules", len(cells))
		}
		for x, cell := range cells {
			top := cell == '█' || cell == '▀'
			bottom := cell == '█' || cell == '▄'
			if top != bitmap[y*2][x] || bottom != (y*2+1 < len(bitmap) && bitmap[y*2+1][x]) {
				t.Fatalf("terminal cell at %d,%d corrupts QR modules", x, y)
			}
		}
	}
	for y, row := range bitmap {
		for x, dark := range row {
			if dark && (x < 4 || y < 4 || x >= len(bitmap)-4 || y >= len(bitmap)-4) {
				t.Fatal("missing standard four-module quiet zone")
			}
		}
	}
}
