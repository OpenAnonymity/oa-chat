package main

import (
	"context"
	"errors"
	"os"
	"time"

	"github.com/OpenAnonymity/oa-chat/daemon/internal/config"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/relay"
	"github.com/OpenAnonymity/oa-chat/daemon/internal/zkapi"
)

func prepareSepoliaAccess(ctx context.Context, dir string, c config.Config, ui setupPrompter) error {
	return configureSepoliaAccess(ctx, dir, c, ui, false)
}

func changeSepoliaAccess(ctx context.Context, dir string, c config.Config, ui setupPrompter) error {
	return configureSepoliaAccess(ctx, dir, c, ui, true)
}

func checkSepoliaAccess(ctx context.Context, dir string, c config.Config, _ setupPrompter) error {
	if c.ZKAPI.Network != "sepolia" {
		return nil
	}
	password, err := config.SepoliaPassword(dir, c.ZKAPI.Network)
	if err != nil {
		return err
	}
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return zkapi.CheckTestnetPassword(checkCtx, c.ZKAPI.Network, password, client)
}

func configureSepoliaAccess(ctx context.Context, dir string, c config.Config, ui setupPrompter, change bool) error {
	if c.ZKAPI.Network != "sepolia" {
		return nil
	}
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	return configureSepoliaPassword(ctx, dir, ui, change, func(ctx context.Context, password string) error {
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		return zkapi.CheckTestnetPassword(checkCtx, c.ZKAPI.Network, password, client)
	})
}

// The password action deliberately avoids loading a broken saved password so
// it can repair that file without changing wallet state or starting a service.
func configureSepoliaPassword(ctx context.Context, dir string, ui setupPrompter, change bool, check func(context.Context, string) error) error {
	_, override := os.LookupEnv("OA_ZKAPI_TESTNET_PASSWORD")
	override = override || os.Getenv("OA_ZKAPI_TESTNET_PASSWORD_FILE") != ""
	if change && override {
		return errors.New("Sepolia password is overridden by the environment; update OA_ZKAPI_TESTNET_PASSWORD or OA_ZKAPI_TESTNET_PASSWORD_FILE and restart")
	}
	var password string
	var err error
	if !change {
		password, err = config.SepoliaPassword(dir, "sepolia")
		if err != nil {
			return err
		}
	}
	prompt := change
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if prompt {
			secret, ok := ui.(interface {
				Secret(context.Context, string) (string, error)
			})
			if !ok {
				return errors.New("Sepolia requires a shared password; run oa-chat config in a terminal")
			}
			ui.Printf("Sepolia access requires the shared testnet password. It is saved only in this private configuration directory.\n")
			password, err = secret.Secret(ctx, "Sepolia password (hidden)")
			if err != nil {
				return err
			}
			if password == "" {
				return errors.New("Sepolia password was empty; run oa-chat config again to continue")
			}
		}
		err = check(ctx, password)
		if err == nil {
			if err := ctx.Err(); err != nil {
				return err
			}
			if prompt {
				return config.SaveSepoliaPassword(dir, password)
			}
			return nil
		}
		var rejected *zkapi.Error
		if !errors.As(err, &rejected) || rejected.Code != "testnet_password_required" {
			return err
		}
		if override {
			return errors.New("Sepolia rejected the configured password; update OA_ZKAPI_TESTNET_PASSWORD or OA_ZKAPI_TESTNET_PASSWORD_FILE and restart")
		}
		if prompt {
			ui.Printf("Sepolia did not accept that password. Try again or press Ctrl+C to cancel.\n")
		}
		prompt = true
	}
}
