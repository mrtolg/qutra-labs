//! Why a cloud call did not work, in the states the page shows (spec
//! 2026-10-07 §7.2). Nothing here carries a key or a response body.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum AiError {
    /// No key is saved for this connection.
    NoKey,
    /// A key is saved but cannot be read (Credential Manager refused, or the
    /// value was written by something else). Saving it again fixes it.
    KeyUnreadable,
    /// Nothing at the custom address answered as a service (404): the
    /// address is usually missing its `/v1`.
    AddressNotFound,
    /// 401: the key was refused.
    KeyInvalid,
    /// 402: the account has a billing problem.
    Billing,
    /// 403 / 404: this key may not use this model or endpoint.
    NoAccess,
    /// 413: the request is larger than the service takes.
    TooLarge,
    /// 429, with the wait the service asked for when it said.
    #[serde(rename_all = "camelCase")]
    RateLimited { retry_after_seconds: Option<u64> },
    /// 500 / 502 / 503 / 504 / 529: the service is busy or failing.
    Busy,
    /// The service could not be reached.
    Offline,
    /// The service stopped answering partway, or never began.
    Timeout,
    /// The user stopped the answer.
    Cancelled,
    /// Another refusal: a bug on our side rather than the user's.
    #[serde(rename_all = "camelCase")]
    BadRequest { status: u16 },
    /// An answer this version cannot read, or a redirect it will not follow.
    Unexpected,
}

pub fn error_for_status(status: u16, retry_after: Option<&str>) -> AiError {
    match status {
        401 => AiError::KeyInvalid,
        402 => AiError::Billing,
        403 | 404 => AiError::NoAccess,
        413 => AiError::TooLarge,
        429 => AiError::RateLimited {
            retry_after_seconds: retry_after.and_then(|value| value.trim().parse().ok()),
        },
        500 | 502 | 503 | 504 | 529 => AiError::Busy,
        // A redirect could carry the key to another host; it is never followed.
        300..=399 => AiError::Unexpected,
        _ => AiError::BadRequest { status },
    }
}

pub fn error_for_transport(err: &reqwest::Error) -> AiError {
    if err.is_decode() || err.is_body() {
        AiError::Unexpected
    } else {
        AiError::Offline
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_the_states_the_page_shows() {
        assert_eq!(error_for_status(401, None), AiError::KeyInvalid);
        assert_eq!(error_for_status(402, None), AiError::Billing);
        assert_eq!(error_for_status(403, None), AiError::NoAccess);
        assert_eq!(error_for_status(404, None), AiError::NoAccess);
        assert_eq!(error_for_status(413, None), AiError::TooLarge);
        assert_eq!(
            error_for_status(429, Some(" 12 ")),
            AiError::RateLimited {
                retry_after_seconds: Some(12)
            }
        );
        assert_eq!(
            error_for_status(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            AiError::RateLimited {
                retry_after_seconds: None
            }
        );
        for busy in [500, 502, 503, 504, 529] {
            assert_eq!(error_for_status(busy, None), AiError::Busy, "{busy}");
        }
        assert_eq!(error_for_status(302, None), AiError::Unexpected);
        assert_eq!(
            error_for_status(400, None),
            AiError::BadRequest { status: 400 }
        );
    }

    #[test]
    fn errors_reach_the_page_as_codes() {
        assert_eq!(
            serde_json::to_value(AiError::RateLimited {
                retry_after_seconds: Some(3)
            })
            .unwrap(),
            serde_json::json!({ "code": "rate_limited", "retryAfterSeconds": 3 })
        );
        assert_eq!(
            serde_json::to_value(AiError::KeyInvalid).unwrap(),
            serde_json::json!({ "code": "key_invalid" })
        );
        assert_eq!(
            serde_json::to_value(AiError::BadRequest { status: 400 }).unwrap(),
            serde_json::json!({ "code": "bad_request", "status": 400 })
        );
    }
}
