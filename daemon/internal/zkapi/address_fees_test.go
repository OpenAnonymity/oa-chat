package zkapi

import (
	"context"
	"encoding/json"
	"math"
	"math/big"
	"net/http"
	"strings"
	"testing"
	"time"
)

func sampleFeeHistory() addressFeeHistory {
	return addressFeeHistory{OldestBlock: "0x0", BaseFees: []string{"0x64", "0x64", "0x64", "0x64", "0x64"}, GasUsed: []float64{0.2, 0.4, 0, 0.8}, Rewards: [][]string{{"0xf4240"}, {"0x2dc6c0"}, {"0x0"}, {"0x1e8480"}}}
}
func TestLowPriorityFeeUsesMedianNonemptyLowBids(t *testing.T) {
	history := sampleFeeHistory()
	tip, err := lowPriorityFee(history, 3, big.NewInt(100))
	if err != nil || tip.String() != "2000000" {
		t.Fatal("wrong low-fee median", tip, err)
	}
	history.GasUsed = []float64{0, 0, 0, 0}
	for i := range history.Rewards {
		history.Rewards[i] = []string{"0x0"}
	}
	tip, err = lowPriorityFee(history, 3, big.NewInt(100))
	if err != nil || tip.String() != "1000000" {
		t.Fatal("empty history did not use minimum")
	}
}
func TestLowPriorityFeeRejectsInconsistentHistory(t *testing.T) {
	for _, scenario := range []string{"window", "bases", "base mismatch", "rewards", "ratio", "nan", "empty reward", "padded quantity", "negative", "oversized"} {
		t.Run(scenario, func(t *testing.T) {
			h := sampleFeeHistory()
			switch scenario {
			case "window":
				h.OldestBlock = "0x1"
			case "bases":
				h.BaseFees = h.BaseFees[:4]
			case "base mismatch":
				h.BaseFees[3] = "0x65"
			case "rewards":
				h.Rewards[0] = append(h.Rewards[0], "0x0")
			case "ratio":
				h.GasUsed[0] = 1.1
			case "nan":
				h.GasUsed[0] = math.NaN()
			case "empty reward":
				h.Rewards[2][0] = "0x1"
			case "padded quantity":
				h.Rewards[0][0] = "0x01"
			case "negative":
				h.Rewards[0][0] = "-0x1"
			case "oversized":
				h.BaseFees[0] = "0x1" + strings.Repeat("0", 64)
			}
			if _, err := lowPriorityFee(h, 3, big.NewInt(100)); err == nil {
				t.Fatal("malformed fee history accepted")
			}
		})
	}
}
func TestFeeHistoryPinnedToFreshExactLatestHeader(t *testing.T) {
	for _, scenario := range []string{"ok", "old", "future", "history unavailable", "history mismatch"} {
		t.Run(scenario, func(t *testing.T) {
			f := newAddressFixture(t, true)
			upstream := f.h.client.inference.Transport
			f.h.client.inference.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
				raw, err := ioReadAndRestore(r)
				if err != nil {
					return nil, err
				}
				var req struct {
					Method string            `json:"method"`
					Params []json.RawMessage `json:"params"`
				}
				_ = json.Unmarshal(raw, &req)
				response, err := upstream.RoundTrip(r)
				if err != nil {
					return response, err
				}
				if req.Method == "eth_feeHistory" {
					var count, block string
					var reward []int
					_ = json.Unmarshal(req.Params[0], &count)
					_ = json.Unmarshal(req.Params[1], &block)
					_ = json.Unmarshal(req.Params[2], &reward)
					if count != "0x14" || block != "0x20" || len(reward) != 1 || reward[0] != 10 {
						t.Error("fee history not pinned to sampled header and low bid percentile")
					}
					if scenario == "history unavailable" {
						response.Body.Close()
						return withdrawalJSONResponse(r, 503, map[string]any{}), nil
					}
				}
				if req.Method != "eth_getBlockByNumber" && req.Method != "eth_feeHistory" {
					return response, nil
				}
				var envelope map[string]any
				_ = json.NewDecoder(response.Body).Decode(&envelope)
				response.Body.Close()
				if req.Method == "eth_getBlockByNumber" {
					block := envelope["result"].(map[string]any)
					if scenario == "old" {
						block["timestamp"] = "0x" + big.NewInt(time.Now().Add(-121*time.Second).Unix()).Text(16)
					}
					if scenario == "future" {
						block["timestamp"] = "0x" + big.NewInt(time.Now().Add(31*time.Second).Unix()).Text(16)
					}
				}
				if req.Method == "eth_feeHistory" && scenario == "history mismatch" {
					history := envelope["result"].(map[string]any)
					history["oldestBlock"] = "0xc"
				}
				return withdrawalJSONResponse(r, 200, envelope), nil
			})
			_, err := f.h.QuoteAddressDeposit(context.Background(), 100000)
			if scenario == "ok" && err != nil {
				t.Fatal(err)
			}
			if scenario != "ok" && err == nil {
				t.Fatal("unsafe fee sample produced quote")
			}
			if len(f.submitted) != 0 {
				t.Fatal("quote signed")
			}
		})
	}
}
func TestPublicSweepRejectsContractButExactContractReturnSimulates(t *testing.T) {
	f := newAddressFixture(t, true)
	_, _ = f.h.Address(context.Background())
	upstream := f.h.client.inference.Transport
	f.h.client.inference.Transport = withdrawalRoundTripper(func(r *http.Request) (*http.Response, error) {
		raw, err := ioReadAndRestore(r)
		if err != nil {
			return nil, err
		}
		var req struct {
			Method string `json:"method"`
		}
		_ = json.Unmarshal(raw, &req)
		if req.Method == "eth_getCode" {
			return withdrawalJSONResponse(r, 200, map[string]any{"jsonrpc": "2.0", "id": 1, "result": "0x6000"}), nil
		}
		return upstream.RoundTrip(r)
	})
	if _, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, ""); err == nil || len(f.submitted) != 0 {
		t.Fatal("contract sweep accepted")
	}
	q, err := f.h.QuoteAddressReturn(context.Background(), withdrawalTestDestination, "123456789123456789")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.h.ApproveAddressReturn(context.Background(), q.ID); err != nil {
		t.Fatal("exact contract transfer was not simulated", err)
	}
}
