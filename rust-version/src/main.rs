use axum::{
    extract::DefaultBodyLimit,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{env, net::SocketAddr};
use tower_http::limit::RequestBodyLimitLayer;

#[derive(Deserialize)]
struct TicketRequest {
    ticket_id: Option<String>,
    channel: Option<String>,
    locale: Option<String>,
    message: Option<String>,
}

#[derive(Serialize)]
struct TicketResponse {
    ticket_id: String,
    case_type: &'static str,
    severity: &'static str,
    department: &'static str,
    agent_summary: String,
    human_review_required: bool,
    confidence: f64,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: &'static str,
}

#[derive(Clone, Copy)]
struct Classification {
    case_type: &'static str,
    confidence: f64,
}

#[tokio::main]
async fn main() {
    let port = env::var("PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(3001);

    let app = Router::new()
        .route("/health", get(health))
        .route("/sort-ticket", post(sort_ticket_handler))
        .route("/bench/json", post(bench_json_handler))
        .route("/bench/cpu", post(bench_cpu_handler))
        .fallback(not_found)
        .layer(RequestBodyLimitLayer::new(8 * 1024))
        .layer(DefaultBodyLimit::max(8 * 1024));

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    println!("Rust QueueStorm server listening on http://{}", addr);
    axum::serve(listener, app).await.unwrap();
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn sort_ticket_handler(
    payload: Result<Json<TicketRequest>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(ticket) = match payload {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Request body must be valid JSON." })),
            )
                .into_response()
        }
    };

    if let Some(error) = validate_ticket(&ticket) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": error })),
        )
            .into_response();
    }

    Json(sort_ticket(
        ticket.ticket_id.as_deref().unwrap(),
        ticket.message.as_deref().unwrap(),
    ))
    .into_response()
}

async fn bench_json_handler(
    payload: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Request body must be valid JSON." })),
            )
                .into_response()
        }
    };

    Json(bench_json(&body)).into_response()
}

async fn bench_cpu_handler(
    payload: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    let Json(body) = match payload {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({ "error": "Request body must be valid JSON." })),
            )
                .into_response()
        }
    };

    let text = body.get("text").and_then(Value::as_str).unwrap_or("");
    let rounds = body
        .get("rounds")
        .and_then(Value::as_u64)
        .unwrap_or(1_000)
        .clamp(1, 10_000) as u32;

    Json(serde_json::json!({
        "bytes": text.len(),
        "rounds": rounds,
        "checksum": checksum(text, rounds, 2166136261),
    }))
    .into_response()
}

async fn not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "Not found.",
        }),
    )
}

fn validate_ticket(ticket: &TicketRequest) -> Option<&'static str> {
    match ticket.ticket_id.as_deref() {
        Some(value) if !value.trim().is_empty() => {}
        _ => return Some("ticket_id is required and must be a non-empty string."),
    }

    match ticket.message.as_deref() {
        Some(value) if !value.trim().is_empty() => {}
        _ => return Some("message is required and must be a non-empty string."),
    }

    if let Some(channel) = ticket.channel.as_deref() {
        if !matches!(channel, "app" | "sms" | "call_center" | "merchant_portal") {
            return Some("channel must be one of: app, sms, call_center, merchant_portal.");
        }
    }

    if let Some(locale) = ticket.locale.as_deref() {
        if !matches!(locale, "bn" | "en" | "mixed") {
            return Some("locale must be one of: bn, en, mixed.");
        }
    }

    None
}

fn sort_ticket(ticket_id: &str, message: &str) -> TicketResponse {
    let normalized = normalize(message);
    let amount = extract_amount(&normalized);
    let classification = classify_case(&normalized);
    let severity = determine_severity(classification.case_type, &normalized, amount);
    let department = department_for(classification.case_type, severity);

    TicketResponse {
        ticket_id: ticket_id.to_string(),
        case_type: classification.case_type,
        severity,
        department,
        agent_summary: make_summary(classification.case_type, amount),
        human_review_required: classification.case_type == "phishing_or_social_engineering"
            || severity == "critical",
        confidence: round_confidence(classification.confidence),
    }
}

fn bench_json(body: &Value) -> Value {
    let items = body
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut active_count = 0u64;
    let mut amount_total = 0.0f64;
    let mut label_checksum = 2166136261u32;

    for item in items {
        if item.get("active").and_then(Value::as_bool).unwrap_or(false) {
            active_count += 1;
        }
        if let Some(amount) = item.get("amount").and_then(Value::as_f64) {
            amount_total += amount;
        }
        if let Some(label) = item.get("label").and_then(Value::as_str) {
            label_checksum = checksum(label, 1, label_checksum);
        }
    }

    serde_json::json!({
        "item_count": items.len(),
        "active_count": active_count,
        "amount_total": (amount_total * 100.0).round() / 100.0,
        "label_checksum": label_checksum,
    })
}

fn normalize(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn classify_case(message: &str) -> Classification {
    let mut best_case = "wrong_transfer";
    let mut best_score = 0usize;
    let mut phishing_score = 0usize;
    let credential_score = score(message, CREDENTIAL_WORDS);

    for (case_type, words) in CASE_KEYWORDS {
        let current = score(message, words);
        if *case_type == "phishing_or_social_engineering" {
            phishing_score = current;
        }
        if current > best_score {
            best_case = case_type;
            best_score = current;
        }
    }

    if credential_score > 0 && has_any(message, CREDENTIAL_RISK_CONTEXT_WORDS) {
        phishing_score += credential_score;
    }

    if phishing_score > 0 {
        return Classification {
            case_type: "phishing_or_social_engineering",
            confidence: (0.78 + phishing_score as f64 * 0.05).min(0.98),
        };
    }

    if best_score == 0 {
        return Classification {
            case_type: "other",
            confidence: 0.55,
        };
    }

    Classification {
        case_type: best_case,
        confidence: (0.68 + best_score as f64 * 0.07).min(0.95),
    }
}

fn determine_severity(case_type: &str, message: &str, amount: Option<u32>) -> &'static str {
    if case_type == "phishing_or_social_engineering" {
        return "critical";
    }

    if has_any(message, URGENT_WORDS) {
        return "high";
    }

    if case_type == "wrong_transfer" || case_type == "payment_failed" {
        return "high";
    }

    if case_type == "refund_request" {
        if amount.is_some_and(|value| value >= 10_000) || has_any(message, CONTESTED_REFUND_WORDS) {
            return "medium";
        }
        return "low";
    }

    "low"
}

fn department_for(case_type: &str, severity: &str) -> &'static str {
    match case_type {
        "phishing_or_social_engineering" => "fraud_risk",
        "payment_failed" => "payments_ops",
        "wrong_transfer" => "dispute_resolution",
        "refund_request" if severity != "low" => "dispute_resolution",
        _ => "customer_support",
    }
}

fn make_summary(case_type: &str, amount: Option<u32>) -> String {
    match case_type {
        "wrong_transfer" => match amount {
            Some(value) => format!(
                "Customer reports sending {} BDT to the wrong recipient and requests recovery assistance.",
                value
            ),
            None => "Customer reports sending to the wrong recipient and requests recovery assistance.".to_string(),
        },
        "payment_failed" => {
            "Customer reports a failed payment or transaction where balance may have been deducted.".to_string()
        }
        "refund_request" => "Customer requests a refund or reversal for a previous transaction.".to_string(),
        "phishing_or_social_engineering" => {
            "Customer reports a suspicious contact or possible credential-targeting attempt that needs fraud review."
                .to_string()
        }
        _ => "Customer reports a general issue that does not match payment, refund, transfer, or fraud categories."
            .to_string(),
    }
}

fn extract_amount(message: &str) -> Option<u32> {
    let mut max_amount = None;
    let mut current = String::new();

    for ch in message.replace(',', "").chars() {
        if ch.is_ascii_digit() {
            current.push(ch);
            continue;
        }

        consider_amount(&current, &mut max_amount);
        current.clear();
    }

    consider_amount(&current, &mut max_amount);
    max_amount
}

fn consider_amount(raw: &str, max_amount: &mut Option<u32>) {
    if (4..=7).contains(&raw.len()) {
        if let Ok(value) = raw.parse::<u32>() {
            if max_amount.is_none_or(|current| value > current) {
                *max_amount = Some(value);
            }
        }
    }
}

fn score(message: &str, words: &[&str]) -> usize {
    words.iter().filter(|word| message.contains(**word)).count()
}

fn has_any(message: &str, words: &[&str]) -> bool {
    words.iter().any(|word| message.contains(*word))
}

fn round_confidence(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn checksum(text: &str, rounds: u32, seed: u32) -> u32 {
    let mut hash = seed;
    for round in 0..rounds {
        for byte in text.as_bytes() {
            hash ^= *byte as u32;
            hash = hash.wrapping_mul(16_777_619);
        }
        hash ^= round;
    }
    hash
}

const CASE_KEYWORDS: &[(&str, &[&str])] = &[
    (
        "phishing_or_social_engineering",
        &[
            "scam",
            "scammer",
            "fraud",
            "fake",
            "phishing",
            "suspicious",
            "called me",
            "someone called",
            "phone call",
            "unknown number",
            "sms",
            "message from",
            "sent me a link",
            "asking my",
            "asked for",
            "asks for",
            "asking for",
            "wants my",
            "account locked",
            "পুরস্কার",
            "প্রতারক",
            "ভুয়া",
        ],
    ),
    (
        "wrong_transfer",
        &[
            "wrong number",
            "wrong recipient",
            "wrong account",
            "wrong person",
            "mistakenly sent",
            "mistake transfer",
            "sent by mistake",
            "sent money to wrong",
            "accidental transfer",
            "recover money",
            "get it back",
            "ভুল নাম্বার",
            "ভুল নম্বর",
            "ভুলে পাঠিয়েছি",
            "ভুলে টাকা",
            "ফিরত চাই",
        ],
    ),
    (
        "payment_failed",
        &[
            "payment failed",
            "transaction failed",
            "failed payment",
            "balance deducted",
            "money deducted",
            "amount deducted",
            "charged but",
            "debited",
            "merchant did not receive",
            "order failed",
            "cashout failed",
            "send money failed",
            "failed but",
            "পেমেন্ট ফেল",
            "লেনদেন ব্যর্থ",
            "টাকা কেটে",
            "ব্যালেন্স কেটে",
        ],
    ),
    (
        "refund_request",
        &[
            "refund",
            "return my money",
            "money back",
            "cancel transaction",
            "changed my mind",
            "reverse transaction",
            "reversal",
            "ফেরত",
            "রিফান্ড",
            "টাকা ফেরত",
            "বাতিল",
        ],
    ),
];

const URGENT_WORDS: &[&str] = &[
    "urgent",
    "immediately",
    "emergency",
    "account hacked",
    "lost all",
    "cannot access",
    "unauthorized",
    "now",
    "জরুরি",
    "হ্যাক",
];
const CONTESTED_REFUND_WORDS: &[&str] =
    &["dispute", "unauthorized", "charged twice", "double charged"];
const CREDENTIAL_WORDS: &[&str] = &[
    "otp",
    "pin",
    "password",
    "passcode",
    "verification code",
    "security code",
    "cvv",
    "card number",
    "ওটিপি",
    "পিন",
    "পাসওয়ার্ড",
];
const CREDENTIAL_RISK_CONTEXT_WORDS: &[&str] = &[
    "ask",
    "asked",
    "asking",
    "asks",
    "want",
    "wants",
    "wanted",
    "called",
    "call",
    "sms",
    "link",
    "fake",
    "scam",
    "scammer",
    "fraud",
    "phishing",
    "suspicious",
    "ভুয়া",
    "প্রতারক",
    "জানতে",
    "চেয়েছে",
];
