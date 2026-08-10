#!/usr/bin/env bash
# Deploy the server to Cloud Run, in one command.
#
# The service is the match relay and the accounts API in one process on one
# port, backed by Firestore. Cloud Run's own filesystem is ephemeral, which is
# exactly why the players are not on it.
#
#   ./server/deploy.sh
#
# Everything below can be overridden from the environment; the defaults are
# this project's. Run it from the repository root, or from anywhere — it finds
# its own directory.
set -euo pipefail

PROJECT="${PROJECT:-teqopen-4c7ae}"
REGION="${REGION:-europe-west1}"
SERVICE="${SERVICE:-teqrallly}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "→ project $PROJECT, region $REGION, service $SERVICE"

# The rules bundle the server scores matches with is generated from the game's
# own source and committed. Deploying a stale one would put the server a
# balance change behind the client, so it is checked here as well as in the
# test suite — this is the last moment it can be caught.
node "$HERE/../scripts/build-rules.mjs" --check

gcloud run deploy "$SERVICE" \
  --project "$PROJECT" \
  --region "$REGION" \
  --source "$HERE" \
  --allow-unauthenticated \
  --set-env-vars "FIRESTORE_PROJECT=$PROJECT" \
  --min-instances 1 \
  --max-instances 4 \
  --cpu 1 \
  --memory 512Mi \
  --timeout 3600 \
  --concurrency 250

# --min-instances 1 because the websocket relay is the point: a cold start in
#   the middle of somebody looking for a match is a lost match, and one warm
#   instance is a few euros a month.
# --timeout 3600 because a match is a long-lived socket, and Cloud Run counts
#   that against the request timeout.
# --concurrency 250 because each connection is nearly idle — the process
#   forwards frames, it does not compute them.

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --format 'value(status.url)')"
echo
echo "deployed: $URL"
echo
echo "Now build the app against it:"
echo "  VITE_RELAY_URL=${URL/https:/wss:} npm run build"
