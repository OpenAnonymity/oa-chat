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
	if c.ZKAPI.Network != "sepolia" {
		return nil
	}
	client, err := relay.NewClient(c.RelayURL)
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	password, err := config.SepoliaPassword(dir, c.ZKAPI.Network)
	if err != nil {
		return err
	}
	for {
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		err = zkapi.CheckTestnetPassword(checkCtx, c.ZKAPI.Network, password, client)
		cancel()
		if err == nil {
			if password != "" && os.Getenv("OA_ZKAPI_TESTNET_PASSWORD") == "" && os.Getenv("OA_ZKAPI_TESTNET_PASSWORD_FILE") == "" {
				return config.SaveSepoliaPassword(dir, password)
			}
			return nil
		}
		var rejected *zkapi.Error
		if !errors.As(err, &rejected) || rejected.Code != "testnet_password_required" {
			return err
		}
		if _, override := os.LookupEnv("OA_ZKAPI_TESTNET_PASSWORD"); override || os.Getenv("OA_ZKAPI_TESTNET_PASSWORD_FILE") != "" {
			return errors.New("Sepolia rejected the configured password; update OA_ZKAPI_TESTNET_PASSWORD or OA_ZKAPI_TESTNET_PASSWORD_FILE and restart")
		}
		secret, ok := ui.(interface {
			Secret(context.Context, string) (string, error)
		})
		if !ok {
			return errors.New("Sepolia requires a shared password; run oa-chat start in a terminal")
		}
		ui.Printf("Sepolia access requires the shared testnet password. It is saved only in this private configuration directory.\n")
		password, err = secret.Secret(ctx, "Sepolia password (hidden)")
		if err != nil {
			return err
		}
		if password == "" {
			return errors.New("Sepolia password was empty; run oa-chat start again to continue")
		}
	}
}
