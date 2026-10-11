//! A connection's model list. Listing the models is also the connection
//! test: it proves the key, the address and the network in one call.
//!
//! Anthropic: `GET /v1/models` with `x-api-key` and `anthropic-version`
//! (Anthropic API reference). OpenAI-compatible:
//! `GET {base}/models` with a bearer key, none for a local server.
//! OpenRouter lists its models without a key, so its key endpoint proves
//! the key first.

use std::time::Duration;

use reqwest::header::HeaderValue;
use serde::{Deserialize, Serialize};

use super::errors::{error_for_status, error_for_transport, AiError};
use super::http::read_capped;
use super::keys::Credential;
use super::providers::{Preset, Target};

pub const ANTHROPIC_VERSION: &str = "2023-06-01";
const LIST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_LIST_BYTES: usize = 1024 * 1024;
const MAX_MODEL_ID_CHARS: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    /// The provider's display name, or the id when it has none.
    pub name: String,
}

pub async fn list_models(
    client: &reqwest::Client,
    target: Target,
    cred: &Credential,
) -> Result<Vec<ModelInfo>, AiError> {
    if target
        == (Target::OpenaiCompat {
            preset: Preset::Openrouter,
        })
    {
        let check = authorized(client.get(format!("{}/key", cred.base_url)), target, cred)?;
        let response = send(check).await?;
        refused(target, &response)?;
    }
    let url = match target {
        Target::Anthropic => format!("{}/v1/models?limit=100", cred.base_url),
        Target::OpenaiCompat { .. } => format!("{}/models", cred.base_url),
        // The search key lists no models.
        Target::Brave => return Err(AiError::Unexpected),
    };
    let response = send(authorized(client.get(url), target, cred)?).await?;
    refused(target, &response)?;
    let body = read_capped(response, MAX_LIST_BYTES).await?;
    parse_models(target, &body)
}

/// The connection's key on a request: `x-api-key` for Anthropic, a bearer
/// token otherwise, none for a local server without one. Marked sensitive
/// so it never appears in a debug print of the request.
fn authorized(
    request: reqwest::RequestBuilder,
    target: Target,
    cred: &Credential,
) -> Result<reqwest::RequestBuilder, AiError> {
    Ok(match target {
        Target::Anthropic => {
            let mut key = HeaderValue::from_str(&cred.key).map_err(|_| AiError::KeyUnreadable)?;
            key.set_sensitive(true);
            request
                .header("x-api-key", key)
                .header("anthropic-version", ANTHROPIC_VERSION)
        }
        Target::OpenaiCompat { .. } if cred.key.is_empty() => request,
        Target::OpenaiCompat { .. } => request.bearer_auth(&cred.key),
        Target::Brave => request,
    })
}

async fn send(request: reqwest::RequestBuilder) -> Result<reqwest::Response, AiError> {
    request
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .map_err(|err| error_for_transport(&err))
}

/// Anything but 200 is the test's answer. A GET carries no body, so an
/// OpenAI-compatible 400 is about the key (Gemini answers a bad key with
/// 400), and a custom address answering 404 is the wrong address.
fn refused(target: Target, response: &reqwest::Response) -> Result<(), AiError> {
    let status = response.status().as_u16();
    if status == 200 {
        return Ok(());
    }
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok());
    Err(match (target, status) {
        (Target::OpenaiCompat { .. }, 400) => AiError::KeyInvalid,
        (
            Target::OpenaiCompat {
                preset: Preset::Custom,
            },
            404 | 405,
        ) => AiError::AddressNotFound,
        _ => error_for_status(status, retry_after),
    })
}

fn parse_models(target: Target, body: &[u8]) -> Result<Vec<ModelInfo>, AiError> {
    #[derive(Deserialize)]
    struct Page {
        data: Vec<Entry>,
    }
    #[derive(Deserialize)]
    struct Entry {
        id: String,
        #[serde(default)]
        display_name: Option<String>,
    }
    let page: Page = serde_json::from_slice(body).map_err(|_| AiError::Unexpected)?;
    let mut models: Vec<ModelInfo> = page
        .data
        .into_iter()
        .filter(|entry| {
            !entry.id.trim().is_empty() && entry.id.chars().count() <= MAX_MODEL_ID_CHARS
        })
        .map(|entry| ModelInfo {
            name: entry
                .display_name
                .filter(|name| !name.trim().is_empty())
                .unwrap_or_else(|| entry.id.clone()),
            id: entry.id,
        })
        .collect();
    // Anthropic lists newest first; an OpenAI-compatible list has no order.
    if matches!(target, Target::OpenaiCompat { .. }) {
        models.sort_by(|a, b| a.id.cmp(&b.id));
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::super::http::client;
    use super::super::providers::Preset;
    use super::*;
    use std::io::{Read, Write};

    const KEY: &str = "sk-test-key-0000-WXYZ";

    /// Answer one request with `response` (status line, headers and body)
    /// and hand back the request as it arrived.
    fn serve(response: String) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let read = stream.read(&mut buf).unwrap_or(0);
            let _ = stream.write_all(response.as_bytes());
            String::from_utf8_lossy(&buf[..read]).into_owned()
        });
        (origin, handle)
    }

    fn json(status: &str, body: &str, extra: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{extra}Connection: close\r\n\r\n{body}",
            body.len()
        )
    }

    fn cred(base_url: &str, key: &str) -> Credential {
        Credential {
            key: key.into(),
            base_url: base_url.into(),
        }
    }

    const OPENAI: Target = Target::OpenaiCompat {
        preset: Preset::Openai,
    };

    #[tokio::test]
    async fn anthropic_lists_its_models_with_the_key_and_version_headers() {
        let body = r#"{"data":[{"id":"claude-opus-5-5","display_name":"Claude Opus 5.5","type":"model"},{"id":"claude-opus-4-8","display_name":"Claude Opus 4.8","type":"model"}],"has_more":false}"#;
        let (origin, request) = serve(json("200 OK", body, ""));

        let models = list_models(&client().unwrap(), Target::Anthropic, &cred(&origin, KEY))
            .await
            .unwrap();

        assert_eq!(
            models,
            vec![
                ModelInfo {
                    id: "claude-opus-5-5".into(),
                    name: "Claude Opus 5.5".into()
                },
                ModelInfo {
                    id: "claude-opus-4-8".into(),
                    name: "Claude Opus 4.8".into()
                },
            ]
        );
        let request = request.join().unwrap().to_ascii_lowercase();
        assert!(
            request.starts_with("get /v1/models?limit=100 "),
            "{request}"
        );
        assert!(request.contains(&format!("x-api-key: {}", KEY.to_ascii_lowercase())));
        assert!(request.contains("anthropic-version: 2023-06-01"));
        assert!(!request.contains("authorization:"));
    }

    #[tokio::test]
    async fn an_openai_compatible_service_lists_sorted_ids_with_a_bearer_key() {
        let body = r#"{"object":"list","data":[{"id":"gpt-b","object":"model"},{"id":"gpt-a","object":"model"},{"id":""}]}"#;
        let (origin, request) = serve(json("200 OK", body, ""));

        let models = list_models(&client().unwrap(), OPENAI, &cred(&origin, KEY))
            .await
            .unwrap();

        let ids: Vec<&str> = models.iter().map(|model| model.id.as_str()).collect();
        assert_eq!(ids, vec!["gpt-a", "gpt-b"]);
        assert_eq!(models[0].name, "gpt-a");
        let request = request.join().unwrap().to_ascii_lowercase();
        assert!(request.starts_with("get /models "), "{request}");
        assert!(request.contains(&format!(
            "authorization: bearer {}",
            KEY.to_ascii_lowercase()
        )));
    }

    #[tokio::test]
    async fn a_local_server_without_a_key_gets_no_authorization_header() {
        let (origin, request) = serve(json("200 OK", r#"{"data":[{"id":"local"}]}"#, ""));
        let custom = Target::OpenaiCompat {
            preset: Preset::Custom,
        };
        list_models(&client().unwrap(), custom, &cred(&origin, ""))
            .await
            .unwrap();
        assert!(!request
            .join()
            .unwrap()
            .to_ascii_lowercase()
            .contains("authorization:"));
    }

    #[tokio::test]
    async fn refusals_become_the_states_the_page_shows() {
        let cases = [
            (
                json("401 Unauthorized", r#"{"type":"error"}"#, ""),
                AiError::KeyInvalid,
            ),
            (
                json("429 Too Many Requests", "{}", "retry-after: 12\r\n"),
                AiError::RateLimited {
                    retry_after_seconds: Some(12),
                },
            ),
            (json("529 Overloaded", "{}", ""), AiError::Busy),
            (json("200 OK", "not json", ""), AiError::Unexpected),
        ];
        for (response, expected) in cases {
            let (origin, request) = serve(response);
            let got = list_models(&client().unwrap(), Target::Anthropic, &cred(&origin, KEY)).await;
            assert_eq!(got, Err(expected));
            request.join().unwrap();
        }
    }

    /// Answer each response in turn, one connection each, and hand back the
    /// requests as they arrived.
    fn serve_many(responses: Vec<String>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            responses
                .into_iter()
                .map(|response| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut buf = vec![0u8; 16 * 1024];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let _ = stream.write_all(response.as_bytes());
                    String::from_utf8_lossy(&buf[..read]).into_owned()
                })
                .collect()
        });
        (origin, handle)
    }

    const OPENROUTER: Target = Target::OpenaiCompat {
        preset: Preset::Openrouter,
    };

    #[tokio::test]
    async fn openrouter_proves_the_key_before_listing() {
        // Its model list needs no key, so a refused key must stop the test
        // before the list is read.
        let (origin, requests) = serve_many(vec![json("401 Unauthorized", "{}", "")]);
        let got = list_models(&client().unwrap(), OPENROUTER, &cred(&origin, KEY)).await;
        assert_eq!(got, Err(AiError::KeyInvalid));
        let seen = requests.join().unwrap();
        assert!(
            seen[0].to_ascii_lowercase().starts_with("get /key "),
            "{}",
            seen[0]
        );

        let (origin, requests) = serve_many(vec![
            json("200 OK", r#"{"data":{"label":"x"}}"#, ""),
            json("200 OK", r#"{"data":[{"id":"openai/gpt-x"}]}"#, ""),
        ]);
        let models = list_models(&client().unwrap(), OPENROUTER, &cred(&origin, KEY))
            .await
            .unwrap();
        assert_eq!(models.len(), 1);
        let seen = requests.join().unwrap();
        assert!(
            seen[1].to_ascii_lowercase().starts_with("get /models "),
            "{}",
            seen[1]
        );
    }

    #[tokio::test]
    async fn a_bad_key_answered_with_400_is_still_a_bad_key() {
        let gemini = Target::OpenaiCompat {
            preset: Preset::Gemini,
        };
        let (origin, request) = serve(json(
            "400 Bad Request",
            r#"[{"error":{"message":"API key not valid"}}]"#,
            "",
        ));
        let got = list_models(&client().unwrap(), gemini, &cred(&origin, KEY)).await;
        assert_eq!(got, Err(AiError::KeyInvalid));
        request.join().unwrap();
    }

    #[tokio::test]
    async fn a_custom_address_that_answers_404_is_the_wrong_address() {
        let custom = Target::OpenaiCompat {
            preset: Preset::Custom,
        };
        let (origin, request) = serve(json("404 Not Found", "{}", ""));
        let got = list_models(&client().unwrap(), custom, &cred(&origin, "")).await;
        assert_eq!(got, Err(AiError::AddressNotFound));
        request.join().unwrap();

        // For Anthropic a 404 still means no access to this model or endpoint.
        let (origin, request) = serve(json("404 Not Found", "{}", ""));
        let got = list_models(&client().unwrap(), Target::Anthropic, &cred(&origin, KEY)).await;
        assert_eq!(got, Err(AiError::NoAccess));
        request.join().unwrap();
    }

    #[tokio::test]
    async fn a_redirect_is_not_followed() {
        // Following it would send the key to whatever the Location names.
        let (origin, request) = serve(json(
            "302 Found",
            "",
            "Location: http://127.0.0.1:9/elsewhere\r\n",
        ));
        let got = list_models(&client().unwrap(), Target::Anthropic, &cred(&origin, KEY)).await;
        assert_eq!(got, Err(AiError::Unexpected));
        request.join().unwrap();
    }

    #[tokio::test]
    async fn an_unreachable_service_is_offline() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let got = list_models(
            &client().unwrap(),
            Target::Anthropic,
            &cred(&format!("http://127.0.0.1:{port}"), KEY),
        )
        .await;
        assert_eq!(got, Err(AiError::Offline));
    }

    #[tokio::test]
    async fn an_oversized_list_is_refused() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            MAX_LIST_BYTES + 1
        );
        let (origin, request) = serve(response);
        let got = list_models(&client().unwrap(), OPENAI, &cred(&origin, KEY)).await;
        assert_eq!(got, Err(AiError::Unexpected));
        request.join().unwrap();
    }
}
