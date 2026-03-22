// Sets minimum required env vars before any module loads.
// Integration tests that rely on workspace-config depend on these being present.
process.env.PRODUCT_NAME = process.env.PRODUCT_NAME ?? "TestApp"
process.env.GITHUB_OWNER = process.env.GITHUB_OWNER ?? "o"
process.env.GITHUB_REPO = process.env.GITHUB_REPO ?? "r"
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "test-token"
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "test-key"
process.env.SLACK_MAIN_CHANNEL = process.env.SLACK_MAIN_CHANNEL ?? "all-testapp"
