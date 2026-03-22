import { config } from "dotenv"
config({ path: "/Users/ssahgal/Developer/agentic-sdlc/.env" })
import { readFile } from "../runtime/github-client"

async function main() {
  const onMain = await readFile("specs/features/onboarding/onboarding.product.md")
  if (onMain) {
    console.log("ON MAIN:\n" + onMain)
  } else {
    const onBranch = await readFile("specs/features/onboarding/onboarding.product.md", "spec/onboarding-product")
    console.log("ON BRANCH:\n" + (onBranch || "not found anywhere"))
  }
}
main().catch(console.error)
