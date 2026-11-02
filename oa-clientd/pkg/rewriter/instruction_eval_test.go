package rewriter

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// Development evaluation, never a production request path. Synthetic cases are
// independent requests, matching the normal per-turn editor input. Mechanical
// checks are only a screen; inspect logged outputs for meaning/style drift.
var instructionCandidates = []struct{ name, text string }{
	{"semantic", `Rewrite supplied requests to suppress the author's writing style, not just correct grammar. First identify meaning independently of wording, then compose a new neutral task statement. Order actions before context and constraints. Use common vocabulary, plain syntax and concise prose in the input language. Collapse synonymous modifiers, duplicated meaning and redundant intensifiers; retain meaningful degrees, comparison and selection criteria. Remove politeness, filler, rhetorical framing and unnecessary first-person narration. Preserve every requirement, uncertainty, negation, condition, preference and relevant personal fact. Do not add facts, resolve ambiguous references or invent answer requirements. Preserve code, quoted literals, names, paths, URLs, numbers and exact-output requirements. JSON string delimiters do not make ordinary prose a protected quotation. Do not answer the request. Simple requests need no headings. Review the result for copied stylistic constructions and semantic drift before returning it.`},
	{"compiler", `Act as a meaning-preserving request compiler, not a copy editor. Discard the original phrasing after extracting the requested actions, subjects, context, constraints and epistemic qualifications. Generate concise impersonal task-first prose in the same language using conventional vocabulary and syntax. Independently organize information: action, subject, necessary context, constraints. Do not preserve the original sentence skeleton or unusual word combinations just because they are grammatical. Merge semantically redundant adjectives, superlatives, intensifiers and repeated ideas into one conventional expression. Remove conversational scaffolding, politeness and rhetorical framing only when irrelevant to intent. Retain meaningful emphasis, uncertainty, ranking intent, scope, exclusions, conditions, preferences and personal circumstances. Never turn uncertainty into certainty, omit an action or introduce new research, ranking, citations or formatting requirements. Keep references unresolved when context is absent. Copy code, exact quotations, names, identifiers, paths, URLs, numeric values and exact-output constraints verbatim. JSON quoting does not protect the prose inside a string. Short already-neutral requests may remain unchanged. Do not answer. Return a compact task statement, not a description of the rewriting process.`},
	{"specification", `Convert each input into a minimal neutral task specification. This is semantic reconstruction, not paraphrasing along the original sentence structure. Identify the task, object, context and constraints, then express them with direct task verbs and ordinary wording in the same language. Remove stylistic fingerprints: verbal tics, fillers, rhetorical questions, pleasantries, redundant modifiers, stacked superlatives, repeated meanings and nonessential personal openings. Replace redundant wording with one conventional expression without removing comparative intent. Preserve every meaningful constraint, question, action, uncertainty, prohibition, condition, preference, degree and relevant personal circumstance. Avoid unsupported assumptions, resolved references, added facts or extra output requirements. Exact quotations, code, identifiers, names, URLs, paths and numbers are protected literals; JSON string delimiters alone do not make text an exact quotation. Do not answer. Use plain task-first prose without headings for simple requests. Before returning, check both that unnecessary source phrasing is gone and that all meaning remains.`},
}

var reconstructionBattery = []struct {
	name, input   string
	retain, avoid []string
}{
	{"recommendations", "give me the top 5 best vegan restaurants in London, Ontario", []string{"5", "vegan", "London", "Ontario"}, []string{"top 5 best", "give me"}},
	{"redundancy", "hey could you maybe give me a quick brief overview of how photosynthesis works? keep it simple pls", []string{"photosynthesis"}, []string{"quick brief", "pls", "hey"}},
	{"privacy", "My goal is privacy preservation. Are there any other things other than skills that go into the structured prompt that I should disable? Maybe AGENTS.md? something else?", []string{"privacy", "skills", "AGENTS.md"}, []string{"other things other than", "My goal is"}},
	{"conditional", "I think this might be a cache issue, but I'm not sure. Suggest checks without running commands. Don't change `/tmp/cache.json`. If a restart is needed, ask first; otherwise just explain. Keep the answer under 100 words.", []string{"`/tmp/cache.json`", "100"}, nil},
	{"literal", "Explain why the phrase \"top 5 best\" is redundant. Keep that quotation exactly as written.", []string{"\"top 5 best\""}, nil},
	{"code", "I'm kinda lost here lol. Explain `x != 0 && y < 5` without changing the code. Don't execute it.", []string{"`x != 0 && y < 5`"}, []string{"lol", "kinda lost"}},
	{"context", "Do the same for the second one, except don't use the earlier assumption.", []string{}, nil},
	{"personal", "I'm vegan and allergic to peanuts; my budget is £20. Suggest dinner options, not restaurants, and don't assume traces are safe.", []string{"vegan", "peanut", "£20"}, []string{"under £20", "less than £20", "below £20"}},
	{"uncertainty", "Is this definitely a memory leak, or could it just be normal caching? I don't want a fix yet, only ways to tell.", []string{}, nil},
	{"exact", "Return exactly OK, with no explanation.", []string{"OK"}, nil},
	{"spanish", "oye, dame un resumen breve y cortito de la fotosíntesis, sin términos técnicos porfa", []string{"fotosíntesis"}, []string{"breve y cortito", "breve y corto", "porfa", "oye"}},
	{"bounds", "can you pretty please pick 4 laptops? maximum £900, including exactly £900, not strictly below it; no used ones", []string{"4", "£900"}, []string{"pretty please"}},
	{"contrast", "I'm not saying A caused B. Could B have caused A instead? Just compare the possibilities, don't decide which is true.", []string{"A", "B"}, nil},
	{"redundancy2", "I need a completely full and total list of the remaining TODOs, but don't fix any of them yet", []string{"TODOs"}, []string{"completely full and total"}},
	{"conditional2", "Only if it fails twice, retry once more; otherwise stop. I really really mean don't retry after a success.", []string{}, nil},
	{"ranking", "Rank these 3 options from cheapest to most expensive; if prices are unknown, say so rather than guessing.", []string{"3"}, nil},
}

func TestLiveInstructionEvaluation(t *testing.T) {
	if os.Getenv("ZKAPI_EVAL_REWRITER") != "1" {
		t.Skip("opt-in local instruction evaluation")
	}
	candidates := instructionCandidates
	if os.Getenv("ZKAPI_EVAL_DEFAULT") == "1" {
		candidates = []struct{ name, text string }{{"default", DefaultInstruction}}
	}
	for _, candidate := range candidates {
		t.Run(candidate.name, func(t *testing.T) {
			for _, sample := range reconstructionBattery {
				t.Run(sample.name, func(t *testing.T) {
					t.Parallel()
					body, _ := json.Marshal(map[string]any{"messages": []map[string]string{{"role": "user", "content": sample.input}}})
					draft, err := Select(body)
					if err != nil {
						t.Fatal(err)
					}
					_, notice, err := draft.Rewrite(context.Background(), Config{URL: "http://localhost:8012", Model: "qwen3.8-flash-next", Instruction: candidate.text})
					if err != nil {
						t.Fatal(err)
					}
					text := notice.Texts[0]
					if os.Getenv("ZKAPI_EVAL_DEFAULT") == "1" && sample.name == "redundancy" {
						lower := strings.ToLower(text)
						if !strings.Contains(lower, "brief") && !strings.Contains(lower, "short") && !strings.Contains(lower, "concise") {
							t.Error("brevity not explicit")
						}
					}
					t.Logf("OUTPUT: %s", text)
					for _, literal := range sample.retain {
						if !strings.Contains(text, literal) {
							t.Errorf("missing %q", literal)
						}
					}
					for _, phrase := range sample.avoid {
						if strings.Contains(strings.ToLower(text), strings.ToLower(phrase)) {
							t.Errorf("retained %q", phrase)
						}
					}
				})
			}
		})
	}
}
