// Setup for pipeline evals — loads .env FIRST so real API keys are available.
// Must run before any module that reads process.env.ANTHROPIC_API_KEY.
import "dotenv/config"

// Fall back to safe values for non-API env vars that workspace-config requires.
process.env.PRODUCT_NAME       = process.env.PRODUCT_NAME       ?? "EvalApp"
process.env.GITHUB_OWNER       = process.env.GITHUB_OWNER       ?? "eval-owner"
process.env.GITHUB_REPO        = process.env.GITHUB_REPO        ?? "eval-repo"
process.env.GITHUB_TOKEN       = process.env.GITHUB_TOKEN       ?? "eval-token"
process.env.SLACK_MAIN_CHANNEL = process.env.SLACK_MAIN_CHANNEL ?? "all-evalapp"
// ANTHROPIC_API_KEY is loaded from .env — no fallback intentionally.
// If missing, the eval will fail immediately with a clear auth error.
