package main

import (
	"errors"
	"fmt"
	"io"
	"math/big"
	"strings"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
	qrcode "github.com/skip2/go-qrcode"
)

const paymentQRColors = "\x1b[38;2;0;0;0;48;2;255;255;255m"
const paymentQRReset = "\x1b[0m"

// paymentRequestURI uses only the public top-up from an authenticated deposit
// quote. ERC-681 value is integer wei, including the quoted fee buffer after
// subtracting ETH already at the funding address, never the vault principal.
func paymentRequestURI(q zkapi.AddressPaymentQuote) (string, error) {
	invalid := errors.New("invalid ETH payment request")
	network := ""
	switch q.ChainID {
	case 1:
		network = "mainnet"
	case 11155111:
		network = "sepolia"
	default:
		return "", invalid
	}
	if q.Kind != "deposit" || q.Amount == 0 || q.Destination != "" || !fundingAddress(q.Address) || strings.EqualFold(q.Address, q.Contract) || !zkapi.MatchesDeployment(network, q.DeploymentID, q.Contract) {
		return "", invalid
	}
	values := make([]*big.Int, 9)
	for i, quantity := range []string{q.PrincipalWei, q.BalanceWei, q.RequiredFeeWei, q.FeeReserveWei, q.FeeBufferWei, q.RequiredTotalWei, q.RecommendedTotalWei, q.ShortfallWei, q.RecommendedTopUpWei} {
		if !fundingBalance(quantity) {
			return "", invalid
		}
		values[i], _ = new(big.Int).SetString(quantity, 10)
		if values[i].BitLen() > 256 {
			return "", invalid
		}
	}
	principal, balance, fee, reserve, buffer := values[0], values[1], values[2], values[3], values[4]
	total, recommended, shortfall, topUp := values[5], values[6], values[7], values[8]
	if principal.Cmp(new(big.Int).Mul(new(big.Int).SetUint64(q.Amount), big.NewInt(1_000_000_000))) != 0 ||
		total.Cmp(new(big.Int).Add(principal, fee)) != 0 ||
		recommended.Cmp(new(big.Int).Add(principal, reserve)) != 0 ||
		buffer.Cmp(new(big.Int).Sub(reserve, fee)) != 0 {
		return "", invalid
	}
	for _, pair := range [][2]*big.Int{{total, shortfall}, {recommended, topUp}} {
		want := new(big.Int).Sub(pair[0], balance)
		if want.Sign() < 0 {
			want.SetInt64(0)
		}
		if want.Cmp(pair[1]) != 0 {
			return "", invalid
		}
	}
	// A funded transaction can proceed without the optional fee buffer. Do not
	// invite another payment solely to replenish that buffer.
	if shortfall.Sign() == 0 || topUp.Sign() == 0 {
		return "", nil
	}
	return fmt.Sprintf("ethereum:%s@%d?value=%s", q.Address, q.ChainID, topUp), nil
}

func printSetupPaymentQR(out io.Writer, q zkapi.AddressPaymentQuote) error {
	uri, err := paymentRequestURI(q)
	if err != nil || uri == "" {
		return err
	}
	code, err := qrcode.New(uri, qrcode.Medium)
	if err != nil {
		return errors.New("could not encode the ETH payment request")
	}
	// Bitmap includes the standard four-module quiet zone. Half blocks preserve
	// square modules in a normal terminal while keeping the symbol under 80 columns.
	qr := terminalPaymentQR(code.Bitmap())
	_, err = fmt.Fprintf(out, "\nScan with an Ethereum wallet:\n%sNetwork: %s\nSend: %s ETH (including the fee buffer)\nTo: %s\nPayment URI: %s\n", qr, fundingNetwork(q.ChainID), fundingUnits(q.RecommendedTopUpWei, 18), q.Address, uri)
	return err
}

func terminalPaymentQR(bitmap [][]bool) string {
	var out strings.Builder
	for y := 0; y < len(bitmap); y += 2 {
		out.WriteString(paymentQRColors)
		for x, top := range bitmap[y] {
			bottom := y+1 < len(bitmap) && bitmap[y+1][x]
			switch {
			case top && bottom:
				out.WriteRune('█')
			case top:
				out.WriteRune('▀')
			case bottom:
				out.WriteRune('▄')
			default:
				out.WriteByte(' ')
			}
		}
		out.WriteString(paymentQRReset)
		out.WriteByte('\n')
	}
	return out.String()
}
