//! Allowlisted GitHub API client. Paths and hosts are constants — the
//! renderer cannot redirect traffic or invent endpoints.

use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::secure;

pub const API_BASE: &str = "https://api.github.com";
pub const TOKEN_KEY: &str = "github.token";
const API_VERSION: &str = "2022-11-28";
const TIMEOUT: Duration = Duration::from_secs(30);
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrokerResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_sec: u64,
    pub interval_sec: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevicePollState {
    Authorized,
    Pending,
    SlowDown,
    Denied,
    Expired,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePollResponse {
    pub state: DevicePollState,
}

#[derive(Debug, Deserialize)]
struct DeviceCodePayload {
    device_code: String,
    user_code: String,
    verification_uri: Option<String>,
    expires_in: Option<u64>,
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DevicePollPayload {
    access_token: Option<String>,
    error: Option<String>,
}

fn validate_client_id(client_id: &str) -> Result<String, String> {
    let value = client_id.trim();
    if value.is_empty() || value.len() > 128 {
        return Err("invalid_client_id".into());
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("invalid_client_id".into());
    }
    Ok(value.to_string())
}

fn validate_device_code(device_code: &str) -> Result<String, String> {
    let value = device_code.trim();
    if value.len() < 8 || value.len() > 256 {
        return Err("invalid_device_code".into());
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err("invalid_device_code".into());
    }
    Ok(value.to_string())
}

fn classify_device_poll(payload: &DevicePollPayload) -> Result<DevicePollState, String> {
    if payload
        .access_token
        .as_deref()
        .is_some_and(|token| !token.is_empty())
    {
        return Ok(DevicePollState::Authorized);
    }
    match payload.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePollState::Pending),
        Some("slow_down") => Ok(DevicePollState::SlowDown),
        Some("access_denied") => Ok(DevicePollState::Denied),
        Some("expired_token") => Ok(DevicePollState::Expired),
        Some("incorrect_client_credentials") => Err("invalid_client_id".into()),
        Some("incorrect_device_code" | "bad_verification_code") => {
            Err("invalid_device_code".into())
        }
        Some("device_flow_disabled") => Err("device_flow_disabled".into()),
        _ => Err("github_device_error".into()),
    }
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "github_client_error".to_string())
}

/// GET allowlist: exact path or prefix with fixed query shapes only.
pub fn validate_get_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() || !trimmed.starts_with('/') {
        return Err("invalid_path".into());
    }
    if trimmed.contains("://") || trimmed.contains("..") {
        return Err("invalid_path".into());
    }
    // `/user` profile
    if trimmed == "/user" {
        return Ok(trimmed.to_string());
    }
    // `/user/repos?...` — only our fixed query keys
    if let Some(rest) = trimmed.strip_prefix("/user/repos") {
        if rest.is_empty() || rest.starts_with('?') {
            if rest.contains("://") {
                return Err("invalid_path".into());
            }
            return Ok(trimmed.to_string());
        }
    }
    Err("path_not_allowed".into())
}

fn load_token() -> Result<String, String> {
    match secure::read_secret(TOKEN_KEY)? {
        Some(t) if !t.is_empty() => Ok(t),
        _ => Err("not_connected".into()),
    }
}

pub async fn device_start(client_id: String) -> Result<DeviceCodeResponse, String> {
    let client_id = validate_client_id(&client_id)?;
    let response = client()?
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "QutraLabs-Qutra Labs")
        .form(&[("client_id", client_id)])
        .send()
        .await
        .map_err(|_| "offline".to_string())?;
    if !response.status().is_success() {
        return Err("github_device_error".into());
    }
    let payload = response
        .json::<DeviceCodePayload>()
        .await
        .map_err(|_| "github_device_error".to_string())?;
    if payload.device_code.is_empty() || payload.user_code.is_empty() {
        return Err("github_device_error".into());
    }
    Ok(DeviceCodeResponse {
        device_code: payload.device_code,
        user_code: payload.user_code,
        verification_uri: payload
            .verification_uri
            .unwrap_or_else(|| "https://github.com/login/device".into()),
        expires_in_sec: payload.expires_in.unwrap_or(900),
        interval_sec: payload.interval.unwrap_or(5).max(1),
    })
}

pub async fn device_poll(
    client_id: String,
    device_code: String,
) -> Result<DevicePollResponse, String> {
    let client_id = validate_client_id(&client_id)?;
    let device_code = validate_device_code(&device_code)?;
    let response = client()?
        .post(TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "QutraLabs-Qutra Labs")
        .form(&[
            ("client_id", client_id),
            ("device_code", device_code),
            (
                "grant_type",
                "urn:ietf:params:oauth:grant-type:device_code".to_string(),
            ),
        ])
        .send()
        .await
        .map_err(|_| "offline".to_string())?;
    if !response.status().is_success() {
        return Err("github_device_error".into());
    }
    let payload = response
        .json::<DevicePollPayload>()
        .await
        .map_err(|_| "github_device_error".to_string())?;
    let state = classify_device_poll(&payload)?;
    if state == DevicePollState::Authorized {
        let token = payload
            .access_token
            .ok_or_else(|| "github_device_error".to_string())?;
        secure::write_secret(TOKEN_KEY, &token)?;
    }
    Ok(DevicePollResponse { state })
}

fn rate_headers(res: &reqwest::Response) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for name in [
        "etag",
        "x-ratelimit-limit",
        "x-ratelimit-remaining",
        "x-ratelimit-reset",
    ] {
        if let Some(v) = res.headers().get(name) {
            if let Ok(s) = v.to_str() {
                out.insert(name.to_string(), s.to_string());
            }
        }
    }
    out
}

/// Authenticated GET against the allowlisted api.github.com path.
pub async fn api_get(
    path: String,
    if_none_match: Option<String>,
) -> Result<BrokerResponse, String> {
    let path = validate_get_path(&path)?;
    let token = load_token()?;
    let url = format!("{API_BASE}{path}");
    let client = client()?;

    let mut req = client
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", "QutraLabs-Qutra Labs");
    if let Some(etag) = if_none_match.filter(|s| !s.is_empty()) {
        req = req.header("If-None-Match", etag);
    }

    let res = req.send().await.map_err(|_| "offline".to_string())?;
    let status = res.status().as_u16();
    let headers = rate_headers(&res);
    let body = res.text().await.map_err(|_| "github_error".to_string())?;
    Ok(BrokerResponse {
        status,
        headers,
        body,
    })
}

/// Fixed GraphQL contribution calendar query. `login` is a username, not a URL.
pub async fn graphql_contributions(login: String) -> Result<BrokerResponse, String> {
    let login = login.trim();
    if login.is_empty() || login.len() > 64 {
        return Err("invalid_login".into());
    }
    if !login
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid_login".into());
    }

    let token = load_token()?;
    let client = client()?;
    let query = r#"query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            weeks {
              contributionDays { date contributionCount }
            }
          }
        }
      }
    }"#;
    let body = serde_json::json!({
        "query": query,
        "variables": { "login": login },
    });

    let res = client
        .post(format!("{API_BASE}/graphql"))
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", format!("Bearer {token}"))
        .header("Content-Type", "application/json")
        .header("X-GitHub-Api-Version", API_VERSION)
        .header("User-Agent", "QutraLabs-Qutra Labs")
        .json(&body)
        .send()
        .await
        .map_err(|_| "offline".to_string())?;

    let status = res.status().as_u16();
    let headers = rate_headers(&res);
    let body = res.text().await.map_err(|_| "github_error".to_string())?;
    Ok(BrokerResponse {
        status,
        headers,
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_user_paths() {
        assert!(validate_get_path("/user").is_ok());
        assert!(validate_get_path("/user/repos?per_page=100&sort=pushed").is_ok());
        assert!(validate_get_path("/user/repos").is_ok());
    }

    #[test]
    fn rejects_path_escape() {
        assert!(validate_get_path("https://evil.com").is_err());
        assert!(validate_get_path("/admin").is_err());
        assert!(validate_get_path("/user/../admin").is_err());
        assert!(validate_get_path("user").is_err());
    }

    #[test]
    fn validates_public_client_and_temporary_device_ids() {
        assert!(validate_client_id("Iv1.abc_DEF-123").is_ok());
        assert!(validate_client_id("bad client").is_err());
        assert!(validate_device_code("abcDEF_123456").is_ok());
        assert!(validate_device_code("../escape").is_err());
    }

    #[test]
    fn classifies_device_poll_without_exposing_tokens() {
        let authorized = DevicePollPayload {
            access_token: Some("gho_secret".into()),
            error: None,
        };
        assert_eq!(
            classify_device_poll(&authorized),
            Ok(DevicePollState::Authorized)
        );
        let pending = DevicePollPayload {
            access_token: None,
            error: Some("authorization_pending".into()),
        };
        assert_eq!(classify_device_poll(&pending), Ok(DevicePollState::Pending));
        let disabled = DevicePollPayload {
            access_token: None,
            error: Some("device_flow_disabled".into()),
        };
        assert_eq!(
            classify_device_poll(&disabled),
            Err("device_flow_disabled".into())
        );
    }
}
