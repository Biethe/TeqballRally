#!/usr/bin/env bash
#
# Remove the art from every commit, branch and tag in the repository's history.
#
#   ./scripts/purge-art-history.sh            # rewrite and verify, push nothing
#   ./scripts/purge-art-history.sh --push     # rewrite, verify, then force-push
#
# Taking the art out of the working tree is not enough. Until this has run,
# `git clone` still yields all 67 MB of it: a deleted file is deleted from the
# tip, not from the fifty commits behind the tip, and `git log` is a complete
# copy of everything that was ever committed.
#
# THIS REWRITES HISTORY. Every commit SHA changes, on every branch and every
# tag, and the result has to be force-pushed. Anybody with a clone must
# re-clone afterwards — a `git pull` onto the old history will try to merge the
# two and put the art back.
#
# Run it while the repository is still PRIVATE. GitHub keeps unreachable
# objects for a while after a force-push and will still serve them to anyone
# who knows the object SHA. On a private repository nobody outside can have
# learned those SHAs, so purging before going public closes the window
# completely; purging afterwards does not, and needs GitHub Support to run a
# real gc on their side.
#
# Tags matter as much as branches. This repository has ~70 `build-*` tags and
# each one pins a commit: leaving them behind keeps the whole pre-purge history
# reachable, and the purge buys nothing at all.

set -euo pipefail

REMOTE="${REMOTE:-https://github.com/Biethe/TeqballRally}"
WORK="${WORK:-$(mktemp -d)/teq-purge.git}"
PUSH="${1:-}"

# The directories that leave history. `assets/fonts` and
# `assets/meshopt_decoder.js` deliberately stay: an OFL font and a public
# third-party script are not ours to withhold, and the page needs both.
PATHS=(
  assets/models
  assets/audio
  assets/textures
  assets/venues
  assets/video
  assets/source-animations
  art-source
)

echo "==> Mirror-cloning $REMOTE"
echo "    (a mirror, not a normal clone: a normal clone of this repository is"
echo "     shallow and would silently leave the older half of history behind)"
git clone --mirror "$REMOTE" "$WORK"
cd "$WORK"
git config --unset remote.origin.mirror || true

before=$(git count-objects -vH | awk '/size-pack/{print $2 $3}')
echo "==> Size before: $before"

echo "==> Rewriting every ref"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f \
  --index-filter "git rm -r --cached --ignore-unmatch -q ${PATHS[*]}" \
  --tag-name-filter cat -- --all

echo "==> Dropping the backup refs and repacking"
rm -rf refs/original
git reflog expire --expire=now --all
git gc --prune=now --aggressive

after=$(git count-objects -vH | awk '/size-pack/{print $2 $3}')
echo "==> Size after: $after (was $before)"

# The check that decides whether this worked. Anything matching an art
# extension still reachable from any ref means a clone still hands it over.
# The Android launcher and splash images are the app's own icons, are needed
# for the native build, and are not licensed art.
echo "==> Verifying"
leaked=$(git rev-list --objects --all \
  | grep -Ei '\.(glb|vat|fbx|mp3|wav|mp4|webp|jpg|jpeg)$' \
  | grep -v 'android/app/src/main/res' || true)
if [ -n "$leaked" ]; then
  echo "FAILED — art is still reachable:"
  echo "$leaked"
  exit 1
fi
echo "    clean: no art reachable from any branch or tag"

if [ "$PUSH" != "--push" ]; then
  echo
  echo "Nothing pushed. Inspect $WORK, then re-run with --push."
  exit 0
fi

echo "==> Force-pushing branches"
git push --force origin 'refs/heads/*:refs/heads/*'

# Tags need their own push: `git push --force <branches>` does not touch them,
# and a tag left pointing at a pre-purge commit keeps that whole history alive.
echo "==> Force-pushing tags"
git push --force origin 'refs/tags/*:refs/tags/*'

echo
echo "Done. Every clone of this repository is now stale and must be re-cloned:"
echo "  the SHAs all changed, and pulling onto the old history reintroduces the art."
