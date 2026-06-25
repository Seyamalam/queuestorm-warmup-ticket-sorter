package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type TicketRequest struct {
	TicketID string `json:"ticket_id"`
	Channel  any    `json:"channel,omitempty"`
	Locale   any    `json:"locale,omitempty"`
	Message  string `json:"message"`
}

type TicketResponse struct {
	TicketID            string  `json:"ticket_id"`
	CaseType            string  `json:"case_type"`
	Severity            string  `json:"severity"`
	Department          string  `json:"department"`
	AgentSummary        string  `json:"agent_summary"`
	HumanReviewRequired bool    `json:"human_review_required"`
	Confidence          float64 `json:"confidence"`
}

type Classification struct {
	CaseType   string
	Confidence float64
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3002"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", health)
	mux.HandleFunc("POST /sort-ticket", sortTicketHandler)
	mux.HandleFunc("/", notFound)

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           limitBody(mux, 8*1024),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       25 * time.Second,
		WriteTimeout:      25 * time.Second,
	}

	log.Printf("Go QueueStorm server listening on http://0.0.0.0:%s", port)
	log.Fatal(server.ListenAndServe())
}

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func sortTicketHandler(w http.ResponseWriter, r *http.Request) {
	var ticket TicketRequest
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(&ticket); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Request body must be valid JSON."})
		return
	}

	if err := validateTicket(ticket); err != "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err})
		return
	}

	writeJSON(w, http.StatusOK, sortTicket(ticket.TicketID, ticket.Message))
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "Not found."})
}

func validateTicket(ticket TicketRequest) string {
	if strings.TrimSpace(ticket.TicketID) == "" {
		return "ticket_id is required and must be a non-empty string."
	}
	if strings.TrimSpace(ticket.Message) == "" {
		return "message is required and must be a non-empty string."
	}
	if ticket.Channel != nil {
		channel, ok := ticket.Channel.(string)
		if !ok || !contains([]string{"app", "sms", "call_center", "merchant_portal"}, channel) {
			return "channel must be one of: app, sms, call_center, merchant_portal."
		}
	}
	if ticket.Locale != nil {
		locale, ok := ticket.Locale.(string)
		if !ok || !contains([]string{"bn", "en", "mixed"}, locale) {
			return "locale must be one of: bn, en, mixed."
		}
	}
	return ""
}

func sortTicket(ticketID string, rawMessage string) TicketResponse {
	message := normalize(rawMessage)
	amount, hasAmount := extractAmount(message)
	classification := classifyCase(message)
	severity := determineSeverity(classification.CaseType, message, amount, hasAmount)

	return TicketResponse{
		TicketID:            ticketID,
		CaseType:            classification.CaseType,
		Severity:            severity,
		Department:          departmentFor(classification.CaseType, severity),
		AgentSummary:        makeSummary(classification.CaseType, amount, hasAmount),
		HumanReviewRequired: classification.CaseType == "phishing_or_social_engineering" || severity == "critical",
		Confidence:          roundConfidence(classification.Confidence),
	}
}

func normalize(text string) string {
	return strings.Join(strings.Fields(strings.ToLower(text)), " ")
}

func classifyCase(message string) Classification {
	bestCase := "wrong_transfer"
	bestScore := 0
	phishingScore := 0
	credentialScore := score(message, credentialWords)

	for _, item := range caseKeywords {
		current := score(message, item.words)
		if item.caseType == "phishing_or_social_engineering" {
			phishingScore = current
		}
		if current > bestScore {
			bestCase = item.caseType
			bestScore = current
		}
	}

	if credentialScore > 0 && hasAny(message, credentialRiskContextWords) {
		phishingScore += credentialScore
	}

	if phishingScore > 0 {
		return Classification{"phishing_or_social_engineering", min(0.98, 0.78+float64(phishingScore)*0.05)}
	}
	if bestScore == 0 {
		return Classification{"other", 0.55}
	}
	return Classification{bestCase, min(0.95, 0.68+float64(bestScore)*0.07)}
}

func determineSeverity(caseType string, message string, amount int, hasAmount bool) string {
	if caseType == "phishing_or_social_engineering" {
		return "critical"
	}
	if hasAny(message, urgentWords) {
		return "high"
	}
	if caseType == "wrong_transfer" || caseType == "payment_failed" {
		return "high"
	}
	if caseType == "refund_request" {
		if (hasAmount && amount >= 10000) || hasAny(message, contestedRefundWords) {
			return "medium"
		}
		return "low"
	}
	return "low"
}

func departmentFor(caseType string, severity string) string {
	switch {
	case caseType == "phishing_or_social_engineering":
		return "fraud_risk"
	case caseType == "payment_failed":
		return "payments_ops"
	case caseType == "wrong_transfer":
		return "dispute_resolution"
	case caseType == "refund_request" && severity != "low":
		return "dispute_resolution"
	default:
		return "customer_support"
	}
}

func makeSummary(caseType string, amount int, hasAmount bool) string {
	switch caseType {
	case "wrong_transfer":
		if hasAmount {
			return fmt.Sprintf("Customer reports sending %d BDT to the wrong recipient and requests recovery assistance.", amount)
		}
		return "Customer reports sending to the wrong recipient and requests recovery assistance."
	case "payment_failed":
		return "Customer reports a failed payment or transaction where balance may have been deducted."
	case "refund_request":
		return "Customer requests a refund or reversal for a previous transaction."
	case "phishing_or_social_engineering":
		return "Customer reports a suspicious contact or possible credential-targeting attempt that needs fraud review."
	default:
		return "Customer reports a general issue that does not match payment, refund, transfer, or fraud categories."
	}
}

func extractAmount(message string) (int, bool) {
	maxAmount := 0
	hasAmount := false
	current := strings.Builder{}

	for _, r := range strings.ReplaceAll(message, ",", "") {
		if r >= '0' && r <= '9' {
			current.WriteRune(r)
			continue
		}
		maxAmount, hasAmount = considerAmount(current.String(), maxAmount, hasAmount)
		current.Reset()
	}

	return considerAmount(current.String(), maxAmount, hasAmount)
}

func considerAmount(raw string, maxAmount int, hasAmount bool) (int, bool) {
	if len(raw) >= 4 && len(raw) <= 7 {
		if value, err := strconv.Atoi(raw); err == nil && (!hasAmount || value > maxAmount) {
			return value, true
		}
	}
	return maxAmount, hasAmount
}

func score(message string, words []string) int {
	total := 0
	for _, word := range words {
		if strings.Contains(message, word) {
			total++
		}
	}
	return total
}

func hasAny(message string, words []string) bool {
	for _, word := range words {
		if strings.Contains(message, word) {
			return true
		}
	}
	return false
}

func roundConfidence(value float64) float64 {
	return float64(int(value*100+0.5)) / 100
}

func contains(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func limitBody(next http.Handler, maxBytes int64) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		next.ServeHTTP(w, r)
	})
}

func min(a float64, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

type keywordGroup struct {
	caseType string
	words    []string
}

var caseKeywords = []keywordGroup{
	{"phishing_or_social_engineering", []string{"scam", "scammer", "fraud", "fake", "phishing", "suspicious", "called me", "someone called", "phone call", "unknown number", "sms", "message from", "sent me a link", "asking my", "asked for", "asks for", "asking for", "wants my", "account locked", "পুরস্কার", "প্রতারক", "ভুয়া"}},
	{"wrong_transfer", []string{"wrong number", "wrong recipient", "wrong account", "wrong person", "mistakenly sent", "mistake transfer", "sent by mistake", "sent money to wrong", "accidental transfer", "recover money", "get it back", "ভুল নাম্বার", "ভুল নম্বর", "ভুলে পাঠিয়েছি", "ভুলে টাকা", "ফিরত চাই"}},
	{"payment_failed", []string{"payment failed", "transaction failed", "failed payment", "balance deducted", "money deducted", "amount deducted", "charged but", "debited", "merchant did not receive", "order failed", "cashout failed", "send money failed", "failed but", "পেমেন্ট ফেল", "লেনদেন ব্যর্থ", "টাকা কেটে", "ব্যালেন্স কেটে"}},
	{"refund_request", []string{"refund", "return my money", "money back", "cancel transaction", "changed my mind", "reverse transaction", "reversal", "ফেরত", "রিফান্ড", "টাকা ফেরত", "বাতিল"}},
}

var urgentWords = []string{"urgent", "immediately", "emergency", "account hacked", "lost all", "cannot access", "unauthorized", "now", "জরুরি", "হ্যাক"}
var contestedRefundWords = []string{"dispute", "unauthorized", "charged twice", "double charged"}
var credentialWords = []string{"otp", "pin", "password", "passcode", "verification code", "security code", "cvv", "card number", "ওটিপি", "পিন", "পাসওয়ার্ড"}
var credentialRiskContextWords = []string{"ask", "asked", "asking", "asks", "want", "wants", "wanted", "called", "call", "sms", "link", "fake", "scam", "scammer", "fraud", "phishing", "suspicious", "ভুয়া", "প্রতারক", "জানতে", "চেয়েছে"}
