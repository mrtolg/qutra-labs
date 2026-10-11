# ADR 0015 — Cloud AI providers and data egress

**Status:** accepted · 2026-10-09

## Context

It was decided on 2026-10-06 that Jarvis may answer through a cloud service: Anthropic (Claude) or an OpenAI-compatible one, chosen in Settings (spec 2026-10-07 D8, D9, D11 and §7). The key lives in Windows Credential Manager, and only Rust uses it. The same decision set what may leave the machine:
- the cloud starts off in every investigation;
- the first question about an investigation shows a card listing what will be sent, and the user allows it once per investigation and can revoke it;
- raw output and files leave only when attached;
- secrets are masked automatically;
- every answer says where it went and how much.

ADR 0004 said there is no provider by default and that what leaves is stated before it leaves. ADR 0012 (line 347) requires a new ADR for any cloud provider for the assistant. The two connections shipped without that ADR; this one closes the gap.

## Decision

1. **Providers.** There are two kinds of connection:
   - **Anthropic:** `api.anthropic.com`, the Messages API with server-side fallback.
   - **OpenAI-compatible:** the OpenAI, Gemini, OpenRouter and Groq presets, or the user's own address.

   None is set by default; the user picks one in Settings › AI. Every request goes from Rust over rustls, and the renderer's content security policy stays shut.
2. **Keys.** From the renderer, keys are write-only:
   - `ai_key_set` saves one;
   - `ai_key_has` returns `{present, last4, baseUrl}`;
   - `ai_key_delete` removes one.

   There is no getter. Keys are kept in the OS credential store and never in SQLite, logs, events or exports (ADR 0005).
3. **What leaves.** A cloud turn sends the conversation: the user's questions and the service's earlier answers, with a fixed system prompt. A Claude answer's content blocks are echoed unchanged. No project, file, run output or investigation goes with it.
   - **With the consent card:** an investigation's summary may go with the first cloud question of a conversation linked to that investigation. It holds:
     - the investigation's title and status;
     - target names;
     - file names and kinds;
     - scan summaries: the built-in steps that ran and what they flagged (a sensitive value such as a location by its label only), and each tool run's command line and state;
     - finding titles, with severity, status and whether a finding is still a draft.

     Folder paths and locations are masked as a report masks them, and the block is cut at a line's end at 8,192 characters. It goes only after the user allows it on a card that shows the question, the exact text as Rust will send it (masked), its size and the connection (provider and host). An investigation keeps one allowance, for one connection, until the user revokes it from the investigation's header or Settings; allowing another connection replaces it, and the card says so. Once allowed, later questions about the investigation send its current summary without asking again. An allowance is never given or matched without a host: a key whose address cannot be read prepares nothing. Each entry in the block is one line of at most 240 characters, and the block ends with a line that says the question follows. A conversation that already holds a summary does not go on in the cloud without that allowance; a question the service declined is left out with its summary, so the next one carries it again.
   - **Raw output and files** leave only when the user attaches them to a message (planned: Jarvis inside an investigation).
4. **Masking.** Before a request is built, Rust masks secrets (`src-tauri/src/ai/mask.rs`). It covers:
   - private keys, whole or cut short;
   - cloud, GitHub, GitLab, Slack, package-registry and payment tokens;
   - JWTs;
   - bearer, basic, cookie and `X-…-Token` headers;
   - passwords in URLs and on command lines: the value after any long flag named for a secret (`--http-password`, `--api-token`, `--cookie`; not `--no-…`), `curl -u user:pass`, and `domain/user:password@host`. Short flags such as `-p` are left alone, because they are as often ports;
   - named secrets such as `password`, `DB_PASSWORD`, `aws_secret_access_key`, `AccountKey` and `token`, with quoted, unquoted and YAML values.

   It masks the text of user messages, and of answers kept without content blocks (a local model's, an OpenAI-compatible service's). Claude's answers go out as their stored blocks, unchanged, because thinking bound to them must stay valid. References and placeholders (`${DB_PASSWORD}`, `********`) are left for the model to see.

   A question goes out masked once. The page then keeps the text that went out, and later turns send exactly that text, so a change to the masking never rewrites a conversation's past. The size shown to the user is the size of the masked request. Masking runs off the async threads, in linear time.
5. **Disclosure.** Under each answer the user sees:
   - the provider, its host and the size sent;
   - how many secrets were masked;
   - the model that answered, and the model that declined when another took over;
   - tokens and an estimated cost.
6. **Append-only history.** A cloud conversation is never edited, and what was sent stays part of it. Revoking an investigation's allowance stops new turns in its linked conversations; it does not edit them.

## Consequences

- **ADR 0004.** This ADR supersedes ADR 0004's "no cloud provider" rule for Jarvis. ADR 0004's principle stands: what leaves is stated before it leaves. The per-answer line and the 6b consent card carry it.
- **ADR 0012.** It meets the requirement at ADR 0012:347 for a cloud provider.
- **Masking is a safety net, not a guarantee.** A secret in a form the patterns do not know can still leave. The chip and Settings say what goes, and the user decides what to type.
- **Older conversations.** A question asked before masking was not kept as sent. If it holds a secret, its next turn sends it masked. For Claude this changes the conversation's prefix once and may invalidate the thinking bound to it. The service then returns an error, and the way on is a new conversation. After that turn, the question is kept as it went out.
- **The local connection.** The Ollama connection (ADRs 0010 and 0012) is unchanged.
- **Internet access.** A conversation may turn on the web for Claude or a local model; what that adds is in ADR 0018.

## What requires another ADR

- Sending anything else by default: files, raw output, or the whole investigation.
- A provider reached outside these two adapters, or a key the renderer can read.
- Turning masking off.
