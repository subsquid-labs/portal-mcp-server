#!/usr/bin/env bash
set -euo pipefail

# Release script: bump version, update CHANGELOG, create git tag.
# Usage: npm run release:patch|minor|major
#   or:  ./scripts/release.sh patch|minor|major

BUMP_TYPE="${1:-}"
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 <patch|minor|major>"
  exit 1
fi

# Get current version
CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP_TYPE" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"
DATE=$(date +%Y-%m-%d)

echo "Bumping $CURRENT -> $NEW_VERSION ($BUMP_TYPE)"

# Check for uncommitted changes
if [[ -n $(git status --porcelain) ]]; then
  echo "Error: Working directory is not clean. Commit or stash changes first."
  exit 1
fi

# Check tag doesn't already exist
if git tag -l "$TAG" | grep -q "$TAG"; then
  echo "Error: Tag $TAG already exists."
  exit 1
fi

# Bump package.json version
node -e "
const pkg = require('./package.json');
pkg.version = '${NEW_VERSION}';
require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# Generate changelog entry from git log since last tag
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
  COMMITS=$(git log "${LAST_TAG}..HEAD" --pretty=format:"- %s" --no-merges)
else
  COMMITS=$(git log --pretty=format:"- %s" --no-merges)
fi

# Insert new entry at top of CHANGELOG.md (after the header lines)
ENTRY="## [${NEW_VERSION}] - ${DATE}\n\n### Changes\n${COMMITS}\n"

if [[ -f CHANGELOG.md ]]; then
  # Insert after the header (line with "and this project adheres")
  awk -v entry="$ENTRY" '
    /^## \[/ && !inserted {
      printf "%s\n\n", entry
      inserted=1
    }
    { print }
  ' CHANGELOG.md > CHANGELOG.tmp && mv CHANGELOG.tmp CHANGELOG.md
else
  printf "# Changelog\n\n%b\n" "$ENTRY" > CHANGELOG.md
fi

# Commit and tag
git add package.json CHANGELOG.md
git commit -m "chore: release v${NEW_VERSION}"
git tag -a "$TAG" -m "v${NEW_VERSION}"

echo ""
echo "Released $TAG"
echo "  - package.json bumped to $NEW_VERSION"
echo "  - CHANGELOG.md updated"
echo "  - Git tag $TAG created"
echo ""
echo "To publish:"
echo "  git push && git push --tags"
echo ""
echo "This will trigger the Docker build workflow automatically."
