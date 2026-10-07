import type { UserConfig } from "@commitlint/types"

// Conventional Commits, like the other repos. The commit-msg hook checks local
// commits and CI checks PR titles.
const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [2, "always", "lower-case"],
    "header-max-length": [2, "always", 100],
    "body-max-line-length": [2, "always", 100]
  }
}

export default config
