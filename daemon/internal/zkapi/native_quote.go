package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"strings"
	"time"
)

// NativeUSDQuote is a prompt-free, independently verified finalized oracle
// snapshot. Reading it does not create a private lease or mutate wallet state.
type NativeUSDQuote struct {
	Asset       string `json:"asset"`
	UnitsPerETH uint64 `json:"units_per_eth"`
	ChainID     uint64 `json:"chain_id"`
	FeedAddress string `json:"feed_address"`
	RoundID     string `json:"round_id"`
	Answer      string `json:"answer"`
	Decimals    uint8  `json:"decimals"`
	UpdatedAt   uint64 `json:"updated_at"`
	ExpiresAt   uint64 `json:"expires_at"`
}

func positiveDecimal(text string, maxBits int) (*big.Int, bool) {
	if text == "" || len(text) > 39 || text[0] == '0' {
		return nil, false
	}
	for _, ch := range text {
		if ch < '0' || ch > '9' {
			return nil, false
		}
	}
	value, ok := new(big.Int).SetString(text, 10)
	return value, ok && value.Sign() > 0 && value.BitLen() <= maxBits
}

func (c *Client) NativeUSDQuote(ctx context.Context) (NativeUSDQuote, error) {
	var quote NativeUSDQuote
	if err := c.Check(ctx); err != nil {
		return quote, err
	}
	raw, err := c.request(ctx, http.MethodGet, "/oa/v1/billing/quote", nil)
	if err != nil {
		return quote, err
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&quote); err != nil {
		return NativeUSDQuote{}, &Error{http.StatusBadGateway, "invalid_native_quote"}
	}
	_, manifest, err := pinnedDeployment(c.config.Network)
	if err != nil {
		return NativeUSDQuote{}, err
	}
	var pinned struct {
		ChainID     uint64 `json:"chain_id"`
		FeedAddress string `json:"native_price_feed_address"`
		Decimals    uint8  `json:"native_price_feed_decimals"`
		MaxAge      uint64 `json:"native_price_max_age_seconds"`
	}
	if json.Unmarshal(manifest, &pinned) != nil {
		return NativeUSDQuote{}, errors.New("invalid packaged native price feed")
	}
	_, validRound := positiveDecimal(quote.RoundID, 80)
	answer, validAnswer := positiveDecimal(quote.Answer, 128)
	now := uint64(time.Now().Unix())
	if !validRound || !validAnswer || answer.Cmp(big.NewInt(1_000_000_000_000_000_000)) > 0 || quote.Asset != "native_eth" || quote.UnitsPerETH != 1_000_000_000 || quote.ChainID != pinned.ChainID || !strings.EqualFold(quote.FeedAddress, pinned.FeedAddress) || quote.Decimals != 8 || quote.Decimals != pinned.Decimals || pinned.MaxAge == 0 || pinned.MaxAge > 86400 || quote.UpdatedAt == 0 || quote.UpdatedAt > now || quote.ExpiresAt <= now || quote.ExpiresAt < quote.UpdatedAt || quote.ExpiresAt-quote.UpdatedAt != pinned.MaxAge {
		return NativeUSDQuote{}, &Error{http.StatusBadGateway, "invalid_native_quote"}
	}
	return quote, nil
}

// GweiForUSD rounds a selected USD principal up to the next native unit. It
// never uses binary floating point and never includes gas in private principal.
func (quote NativeUSDQuote) GweiForUSD(microUSD uint64) (uint64, error) {
	answer, ok := positiveDecimal(quote.Answer, 128)
	if !ok || microUSD == 0 || quote.Asset != "native_eth" || quote.UnitsPerETH != 1_000_000_000 || quote.Decimals != 8 || quote.ExpiresAt <= uint64(time.Now().Unix()) {
		return 0, errors.New("USD deposit requires a current native ETH price quote and a positive amount")
	}
	numerator := new(big.Int).Mul(new(big.Int).SetUint64(microUSD), big.NewInt(100_000_000_000_000_000))
	denominator := new(big.Int).Mul(answer, big.NewInt(1_000_000))
	units, remainder := new(big.Int), new(big.Int)
	units.QuoRem(numerator, denominator, remainder)
	if remainder.Sign() != 0 {
		units.Add(units, big.NewInt(1))
	}
	if !units.IsUint64() || units.Sign() <= 0 || units.Uint64() > 1_000_000_000_000 {
		return 0, errors.New("USD deposit exceeds the 1000 ETH funding limit")
	}
	return units.Uint64(), nil
}
