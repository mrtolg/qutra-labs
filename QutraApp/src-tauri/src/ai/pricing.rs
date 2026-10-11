//! What an answer roughly cost (spec §7.2 "cost line"). Prices are US
//! dollars per million tokens, as published on 2026-10-09; a model not
//! listed shows tokens only. Cache writes (5-minute) cost 1.25× input.
//!
//! Source: Anthropic pricing page (Claude Opus 5.5: $4 / $20,
//! cache reads $0.20; Claude Opus 5 and Opus 4.8: $5 / $25).

use super::turn::Usage;

struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
}

fn price(model: &str) -> Option<Price> {
    let (input, output, cache_read) = match model {
        m if m.starts_with("claude-opus-5-5") => (4.0, 20.0, 0.20),
        m if m.starts_with("claude-opus-5") => (5.0, 25.0, 0.50),
        m if m.starts_with("claude-opus-4-8") => (5.0, 25.0, 0.50),
        _ => return None,
    };
    Some(Price {
        input,
        output,
        cache_read,
    })
}

pub fn cost_usd(model: &str, usage: &Usage) -> Option<f64> {
    let price = price(model)?;
    let per_token = |tokens: u64, per_million: f64| tokens as f64 * per_million / 1_000_000.0;
    Some(
        per_token(usage.input_tokens, price.input)
            + per_token(usage.output_tokens, price.output)
            + per_token(usage.cache_read_tokens, price.cache_read)
            + per_token(usage.cache_write_tokens, price.input * 1.25),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_known_model_has_a_cost_and_an_unknown_one_does_not() {
        let usage = Usage {
            input_tokens: 120,
            output_tokens: 12,
            cache_read_tokens: 1000,
            cache_write_tokens: 100,
            cost_usd: None,
        };
        let cost = cost_usd("claude-opus-5-5", &usage).unwrap();
        // 120×4 + 12×20 + 1000×0.20 + 100×5 = 1420 per million.
        assert!((cost - 0.00142).abs() < 1e-12, "{cost}");
        assert!(cost_usd("claude-opus-4-8", &usage).is_some());
        assert_eq!(cost_usd("gpt-4.1", &usage), None);
    }
}
