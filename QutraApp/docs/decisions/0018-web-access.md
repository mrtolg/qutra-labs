# ADR 0018 — Internet access for Jarvis

**Status:** accepted · 2026-10-11

## Context

Until now Jarvis had no internet. ADR 0015 says what a cloud turn sends and that "a provider reached outside these two adapters" needs its own ADR; ADR 0012 and the threat model of 2026-09-28 keep the model's output untrusted and bound what it may make Rust do. A person now wants Jarvis to look things up. That adds two kinds of traffic: a search service the person did not pick as an AI provider, and pages fetched from addresses that a search result, a page or the person chose.

## Decision

1. **A switch per conversation.** "İnternet" sits in the composer, is off by default and is kept on the conversation (`webAccess`). While it is on, a globe chip says where searches go. The switch is offered for a local model and for Claude. It is not offered for an OpenAI-compatible service: Jarvis talks to those through Chat Completions, which has no search option for the models in use, so nothing is sent for them and Rust refuses the request (`web_not_available`).
2. **Claude.** The search and fetch run on Anthropic's side, as the service's own tools in the Messages request. Their versions follow the model: `web_search_20260209` and `web_fetch_20260209` for Opus 5 and Sonnet 5, `web_search_20250305` alone for any other model. The tools and a second constant system prompt go only while the switch is on. What the service returns (its searches, results and citations) is echoed unchanged like the rest of a Claude answer, a search with no result is not kept, and a run the service pauses is handed back at most three times. Nothing leaves that was not already in the conversation: masking and exclusions (ADR 0015 §4) run on the outgoing text first, and the answer lists the pages it cites, or else the pages found, as links that open through the checked opener.
3. **A local model.** The model gets no network and no tool. When the switch is on, Rust does the work for the turn:
   - a question that holds web addresses reads those pages and nothing else; no key is needed;
   - any other question is searched through the Brave Search API, and the first three results are read. The query is masked like a cloud turn, exclusions included, and the Brave key (`ai.brave.key`, provider `brave`) is kept in the OS credential store like the others (ADR 0005); without one the turn stops with a plain message;
   - the page text goes ahead of the question between markers that carry a random value no page can know, with a line in the system message saying that it is data and never instructions. The frame's own markers (ADR 0012) are untouched. The text is not stored in the conversation.
4. **Every fetch** is http or https only, with no credentials in the address. A name is resolved once, through `net_guard`, and only public answers are used: loopback, private, link-local (including the cloud metadata address), shared, documentation and multicast ranges are refused, an address written as a literal is checked before the request, and every redirect hop is checked again. Single-label and local names are refused. No cookies, no referrer, 5 seconds, at most 1 MiB read, text and HTML only, with scripts, styles and hidden characters removed.
5. **Disclosure.** The Brave query is the only text that goes to a service the person did not choose as a model; the chip says so, and its key is kept with the others.

## Consequences

- Prompt injection through a page remains possible. The mitigations are the nonce markers, the guard line, the closed tool set (the model has none) and the existing approval gates for anything that acts.
- A search through Claude costs what the service charges for it; the estimate shown under an answer counts tokens only.
- Changing the system prompt between turns of one Claude conversation (the switch turned on or off) changes the conversation's prefix once.

## What requires another ADR

- A model that can call a fetch or search tool itself on a local turn.
- Sending anything but the masked question to a search service.
- Fetching with cookies, or from a private network.
