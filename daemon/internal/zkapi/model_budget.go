package zkapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Match chat/zkapi/services/zkapiModelBudget.mjs. New ticket tiers require an
// explicit review. Provider dollar prices never determine the coarse cap.
func modelBudget(ticketCost uint64) (uint64, bool) {
	switch ticketCost {
	case 1, 2:
		return 1_000_000, true
	case 3, 8:
		return 2_000_000, true
	case 5:
		return 3_000_000, true
	case 25:
		return 4_500_000, true
	case 100:
		return 6_000_000, true
	default:
		return 0, false
	}
}

func (c *Client) modelPolicyJSON(ctx context.Context, path string, value any) error {
	deployment, _, err := pinnedDeployment(c.config.Network)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(deployment.Privacy.IssuerURL, "/")+path, nil)
	if err != nil {
		return err
	}
	// This is public policy, fetched through the same cookie-free transport as
	// inference. Neither the selected model nor any credential is transmitted.
	req.Header.Set("Accept", "application/json")
	res, err := c.inference.Do(req)
	if err != nil {
		return &Error{http.StatusBadGateway, "model_policy_unavailable"}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
	if err != nil || res.StatusCode != http.StatusOK || len(raw) > 2<<20 || json.Unmarshal(raw, value) != nil {
		return &Error{http.StatusBadGateway, "model_policy_unavailable"}
	}
	return nil
}

func (c *Client) modelBudgets(ctx context.Context) (map[string]uint64, error) {
	var prices map[string]uint64
	if err := c.modelPolicyJSON(ctx, "/chat/model-tickets", &prices); err != nil {
		return nil, err
	}
	if len(prices) == 0 {
		return nil, &Error{http.StatusBadGateway, "model_policy_unavailable"}
	}
	budgets := make(map[string]uint64, len(prices))
	for id, tickets := range prices {
		if id == "" || strings.TrimSpace(id) != id || tickets == 0 || tickets > 9_007_199_254_740_991 {
			return nil, &Error{http.StatusBadGateway, "model_policy_unavailable"}
		}
		// Keep an explicit unreviewed assignment blocked rather than allowing
		// it to fall through to the web's untiered-model rule.
		budgets[id], _ = modelBudget(tickets)
	}
	var availability struct {
		Disabled *[]string `json:"disabled_models"`
	}
	if err := c.modelPolicyJSON(ctx, "/chat/pinned-models", &availability); err != nil {
		return nil, err
	}
	if availability.Disabled == nil {
		return nil, &Error{http.StatusBadGateway, "model_policy_unavailable"}
	}
	for _, id := range *availability.Disabled {
		if id == "" || strings.TrimSpace(id) != id {
			return nil, &Error{http.StatusBadGateway, "model_policy_unavailable"}
		}
		// Retain a zero sentinel so a disabled exact :online variant cannot
		// regain authorization when request pricing normalizes its base ID.
		budgets[id] = 0
	}
	return budgets, nil
}

func (c *Client) requestBudget(ctx context.Context, body json.RawMessage) (uint64, error) {
	var request struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(body, &request) != nil || request.Model == "" || strings.TrimSpace(request.Model) != request.Model {
		return 0, &Error{http.StatusBadRequest, "invalid_model"}
	}
	budgets, err := c.modelBudgets(ctx)
	if err != nil {
		return 0, err
	}
	// This is the web's only pricing variant normalization. Preserve :free,
	// :batch, etc. as distinct identifiers.
	if budget, exists := budgets[request.Model]; exists && budget == 0 {
		return 0, &Error{http.StatusBadRequest, "model_budget_unavailable"}
	}
	base := strings.TrimSuffix(request.Model, ":online")
	budget, ok := budgets[base]
	if ok && budget == 0 {
		return 0, &Error{http.StatusBadRequest, "model_budget_unavailable"}
	}
	if !ok {
		catalog, err := c.publicModelIDs(ctx)
		if err != nil {
			return 0, err
		}
		if !catalog[base] && !catalog[request.Model] {
			return 0, &Error{http.StatusBadRequest, "model_budget_unavailable"}
		}
		budget = untieredModelBudget(base)
	}
	return budget, nil
}

// Match modelTiers.getTicketCost after the live map has loaded: premium
// opus/image names use tier 3; thinking/instant/reasoning/default fallbacks
// use tier 1 or 2, which both map to the same $1 zkAPI envelope. An unknown
// provider ID cannot acquire a lease merely by choosing a matching name.
func untieredModelBudget(id string) uint64 {
	name := strings.ToLower(id)
	if strings.Contains(name, "opus") || strings.Contains(name, "image") {
		return 2_000_000
	}
	return 1_000_000
}

func (c *Client) publicModelIDs(ctx context.Context) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.config.InferenceBaseURL+"/models", nil)
	if err != nil {
		return nil, &Error{http.StatusBadGateway, "models_unavailable"}
	}
	req.Header.Set("Accept", "application/json")
	res, err := c.inference.Do(req)
	if err != nil {
		return nil, &Error{http.StatusBadGateway, "models_unavailable"}
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, (16<<20)+1))
	var catalog struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err != nil || res.StatusCode != http.StatusOK || len(raw) > 16<<20 || json.Unmarshal(raw, &catalog) != nil || len(catalog.Data) == 0 {
		return nil, &Error{http.StatusBadGateway, "models_unavailable"}
	}
	ids := make(map[string]bool, len(catalog.Data))
	for _, model := range catalog.Data {
		if model.ID == "" || strings.TrimSpace(model.ID) != model.ID {
			return nil, &Error{http.StatusBadGateway, "models_unavailable"}
		}
		ids[model.ID] = true
	}
	return ids, nil
}

func (c *Client) Models(ctx context.Context) (json.RawMessage, error) {
	if err := c.Check(ctx); err != nil {
		return nil, err
	}
	budgets, err := c.modelBudgets(ctx)
	if err != nil {
		return nil, err
	}
	catalog, err := c.publicModelIDs(ctx)
	if err != nil {
		return nil, err
	}
	for id := range catalog {
		base := strings.TrimSuffix(id, ":online")
		if _, exists := budgets[id]; exists {
			continue
		}
		if budget, exists := budgets[base]; exists {
			budgets[id] = budget
		} else {
			budgets[id] = untieredModelBudget(base)
		}
	}
	ids := make([]string, 0, len(budgets))
	for id := range budgets {
		if budgets[id] > 0 {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	models := make([]map[string]any, 0, len(ids))
	for _, id := range ids {
		provider, _, _ := strings.Cut(id, "/")
		models = append(models, map[string]any{"id": id, "object": "model", "created": 0, "owned_by": provider, "oa_request_limit_micro_usd": budgets[id]})
	}
	return json.Marshal(map[string]any{"object": "list", "data": models})
}
