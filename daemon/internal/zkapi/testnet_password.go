package zkapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

const TestnetPasswordHeader = "X-ZKAPI-Testnet-Password"

// CheckTestnetPassword uses the embedded deployment's server, never a remote
// manifest or caller-supplied URL. It cannot redirect the shared credential.
func CheckTestnetPassword(ctx context.Context, network, password string, client *http.Client) error {
	if network != "sepolia" {
		return nil
	}
	_, raw, err := pinnedDeployment(network)
	if err != nil {
		return err
	}
	var manifest struct {
		Server string `json:"protocol_server_url"`
	}
	if json.Unmarshal(raw, &manifest) != nil || manifest.Server == "" || client == nil {
		return errors.New("invalid Sepolia server configuration")
	}
	return checkTestnetPasswordURL(ctx, manifest.Server+"/v2/auth", password, client)
}

func checkTestnetPasswordURL(ctx context.Context, endpoint, password string, client *http.Client) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return errors.New("invalid Sepolia server configuration")
	}
	if password != "" {
		req.Header.Set(TestnetPasswordHeader, password)
	}
	transport := *client
	transport.CheckRedirect = noRedirect
	transport.Jar = nil
	response, err := transport.Do(req)
	if err != nil {
		return errors.New("could not verify Sepolia access; check the server connection and retry")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusUnauthorized {
		return &Error{http.StatusUnauthorized, "testnet_password_required"}
	}
	var result struct {
		Authenticated bool `json:"authenticated"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result) != nil || !result.Authenticated {
		return errors.New("could not verify Sepolia access; server did not confirm authentication")
	}
	return nil
}
