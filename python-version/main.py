from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


CASE_KEYWORDS = {
    "phishing_or_social_engineering": [
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
    "wrong_transfer": [
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
    "payment_failed": [
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
    "refund_request": [
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
}

URGENT_WORDS = [
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
]

CONTESTED_REFUND_WORDS = ["dispute", "unauthorized", "charged twice", "double charged"]

CREDENTIAL_WORDS = [
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
]

CREDENTIAL_RISK_CONTEXT_WORDS = [
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
]

AMOUNT_RE = re.compile(r"(?:৳|tk|taka|bdt)?\s*(\d{4,7})(?:\s*(?:tk|taka|bdt|টাকা))?", re.I)
MAX_BODY_BYTES = 8 * 1024


class Handler(BaseHTTPRequestHandler):
    server_version = "QueueStormPython/1.0"

    def do_GET(self) -> None:
        if self.path == "/health":
            self.write_json(200, {"status": "ok"})
            return

        self.write_json(404, {"error": "Not found."})

    def do_POST(self) -> None:
        if self.path != "/sort-ticket":
            self.write_json(404, {"error": "Not found."})
            return

        content_length = int(self.headers.get("content-length", "0"))
        if content_length > MAX_BODY_BYTES:
            self.write_json(413, {"error": "Request body is too large."})
            return

        try:
            raw_body = self.rfile.read(content_length)
            body = json.loads(raw_body)
        except Exception:
            self.write_json(400, {"error": "Request body must be valid JSON."})
            return

        validation_error = validate_ticket(body)
        if validation_error:
            self.write_json(400, {"error": validation_error})
            return

        self.write_json(200, sort_ticket(body["ticket_id"], body["message"]))

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def write_json(self, status: int, payload: dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def validate_ticket(body: Any) -> str | None:
    if not isinstance(body, dict):
        return "Request body must be a JSON object."

    if not isinstance(body.get("ticket_id"), str) or not body["ticket_id"].strip():
        return "ticket_id is required and must be a non-empty string."

    if not isinstance(body.get("message"), str) or not body["message"].strip():
        return "message is required and must be a non-empty string."

    channel = body.get("channel")
    if channel is not None and channel not in {"app", "sms", "call_center", "merchant_portal"}:
        return "channel must be one of: app, sms, call_center, merchant_portal."

    locale = body.get("locale")
    if locale is not None and locale not in {"bn", "en", "mixed"}:
        return "locale must be one of: bn, en, mixed."

    return None


def sort_ticket(ticket_id: str, raw_message: str) -> dict[str, Any]:
    message = normalize(raw_message)
    amount = extract_amount(message)
    case_type, confidence = classify_case(message)
    severity = determine_severity(case_type, message, amount)

    return {
        "ticket_id": ticket_id,
        "case_type": case_type,
        "severity": severity,
        "department": department_for(case_type, severity),
        "agent_summary": make_summary(case_type, amount),
        "human_review_required": case_type == "phishing_or_social_engineering" or severity == "critical",
        "confidence": round(confidence, 2),
    }


def normalize(text: str) -> str:
    return " ".join(text.casefold().split())


def classify_case(message: str) -> tuple[str, float]:
    scores = {case_type: score(message, words) for case_type, words in CASE_KEYWORDS.items()}
    credential_score = score(message, CREDENTIAL_WORDS)
    phishing_score = scores["phishing_or_social_engineering"]

    if credential_score > 0 and has_any(message, CREDENTIAL_RISK_CONTEXT_WORDS):
        phishing_score += credential_score

    if phishing_score > 0:
        return "phishing_or_social_engineering", min(0.98, 0.78 + phishing_score * 0.05)

    best_case, best_score = max(scores.items(), key=lambda item: item[1])
    if best_score == 0:
        return "other", 0.55

    return best_case, min(0.95, 0.68 + best_score * 0.07)


def determine_severity(case_type: str, message: str, amount: int | None) -> str:
    if case_type == "phishing_or_social_engineering":
        return "critical"
    if has_any(message, URGENT_WORDS):
        return "high"
    if case_type in {"wrong_transfer", "payment_failed"}:
        return "high"
    if case_type == "refund_request":
        if amount is not None and amount >= 10_000:
            return "medium"
        return "medium" if has_any(message, CONTESTED_REFUND_WORDS) else "low"
    return "low"


def department_for(case_type: str, severity: str) -> str:
    if case_type == "phishing_or_social_engineering":
        return "fraud_risk"
    if case_type == "payment_failed":
        return "payments_ops"
    if case_type == "wrong_transfer":
        return "dispute_resolution"
    if case_type == "refund_request" and severity != "low":
        return "dispute_resolution"
    return "customer_support"


def make_summary(case_type: str, amount: int | None) -> str:
    if case_type == "wrong_transfer":
        amount_text = f" {amount} BDT" if amount is not None else ""
        return f"Customer reports sending{amount_text} to the wrong recipient and requests recovery assistance."
    if case_type == "payment_failed":
        return "Customer reports a failed payment or transaction where balance may have been deducted."
    if case_type == "refund_request":
        return "Customer requests a refund or reversal for a previous transaction."
    if case_type == "phishing_or_social_engineering":
        return "Customer reports a suspicious contact or possible credential-targeting attempt that needs fraud review."
    return "Customer reports a general issue that does not match payment, refund, transfer, or fraud categories."


def extract_amount(message: str) -> int | None:
    amounts = [int(match.group(1)) for match in AMOUNT_RE.finditer(message.replace(",", ""))]
    return max(amounts) if amounts else None


def score(message: str, words: list[str]) -> int:
    return sum(1 for word in words if word in message)


def has_any(message: str, words: list[str]) -> bool:
    return any(word in message for word in words)


def main() -> None:
    port = int(os.environ.get("PORT", "3003"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Python QueueStorm server listening on http://0.0.0.0:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
