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
# Paris, because that is where this project's Firestore database is. The two
# do not have to match, and every read pays for it when they do not — the
# database is on the other side of every request the server serves.
REGION="${REGION:-europe-west9}"
SERVICE="${SERVICE:-teqrallly}"
# Warm instances are the one setting here that costs money while nobody is
# playing, so it is the one worth being able to turn off from the outside —
# a throwaway deploy that only has to answer /healthz does not need to be paid
# for around the clock. The default stays 1 for the reason given below.
MIN_INSTANCES="${MIN_INSTANCES:-1}"
# The shared secret RevenueCat sends in the Authorization header of its
# webhook. It is the only thing standing between "RevenueCat says this player
# bought coins" and "anyone on the internet says so", so the deploy stops
# rather than shipping a server that would refuse every purchase silently.
REVENUECAT_WEBHOOK_SECRET="${REVENUECAT_WEBHOOK_SECRET:-}"
if [ -z "$REVENUECAT_WEBHOOK_SECRET" ]; then
  echo "REVENUECAT_WEBHOOK_SECRET is not set." >&2
  echo "Generate one, paste it into the RevenueCat webhook's Authorization" >&2
  echo "header, and export it here before deploying." >&2
  exit 1
fi
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
  --set-env-vars "FIRESTORE_PROJECT=$PROJECT,REVENUECAT_WEBHOOK_SECRET=$REVENUECAT_WEBHOOK_SECRET" \
  --min-instances "$MIN_INSTANCES" \
  --max-instances 4 \
  --cpu 1 \
  --memory 512Mi \
  --timeout 3600 \
  --concurrency 250

# --min-instances 1 because the websocket relay is the point: a cold start in
#   the middle of somebody looking for a match is a lost match, and one warm
#   instance is a few euros a month. MIN_INSTANCES=0 trades that back for
#   nothing to pay while idle, which is the right deal for a service that is
#   only being proved, not played on.
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
