package config

import "testing"

func TestNativeRequestCapAllowlist(t *testing.T) {
	for _, cap := range []uint64{0, 1_000_000, 2_000_000, 3_000_000, 4_500_000, 6_000_000} {
		config, err := Default()
		if err != nil {
			t.Fatal(err)
		}
		config.Backend, config.ZKAPI.RequestLimitMicroUSD = "zkapi", cap
		if err := Validate(config); err != nil {
			t.Errorf("reviewed cap %d rejected: %v", cap, err)
		}
	}
	for _, cap := range []uint64{1, 50_000, 999_999, 1_000_001, 4_000_000, 4_499_999, 4_500_001, 6_000_001, ^uint64(0)} {
		config, err := Default()
		if err != nil {
			t.Fatal(err)
		}
		config.Backend, config.ZKAPI.RequestLimitMicroUSD = "zkapi", cap
		if err := Validate(config); err == nil {
			t.Errorf("unreviewed cap %d accepted", cap)
		}
	}
}
