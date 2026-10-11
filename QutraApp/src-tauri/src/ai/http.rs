//! The HTTP client for cloud AI calls. Redirects are never followed: a
//! redirect could carry the key header to another host.

use std::time::Duration;

use futures_util::StreamExt;

use super::errors::{error_for_transport, AiError};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

pub fn client() -> Result<reqwest::Client, AiError> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("QutraLabs/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| AiError::Unexpected)
}

/// Read a whole response body, refusing one larger than `cap` bytes.
pub async fn read_capped(response: reqwest::Response, cap: usize) -> Result<Vec<u8>, AiError> {
    if response
        .content_length()
        .is_some_and(|length| length > cap as u64)
    {
        return Err(AiError::Unexpected);
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| error_for_transport(&err))?;
        if body.len() + chunk.len() > cap {
            return Err(AiError::Unexpected);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}
