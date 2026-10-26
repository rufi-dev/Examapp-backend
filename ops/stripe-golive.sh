#!/bin/sh
# Stripe go-live, step 1: make the staged STRIPE_LIVE_* values the active ones.
# Card billing stays gated (admins + STRIPE_BILLING_TESTERS) until step 2 sets
# STRIPE_BILLING_ENABLED=true. The sandbox values are kept as STRIPE_TEST_* so
# `ops/stripe-golive.sh rollback` returns to the sandbox.
set -e
cd /root/examopia-backend
cp .env ".env.bak-golive-$(date +%Y%m%d-%H%M%S)"
val() { grep "^$1=" .env | tail -1 | cut -d= -f2-; }
put() { sed -i "/^$1=/d" .env; echo "$1=$2" >> .env; }

if [ "$1" = "rollback" ]; then
  for k in SECRET_KEY WEBHOOK_SECRET PRICE_PRO_MONTHLY PRICE_PREMIUM_MONTHLY; do
    put "STRIPE_$k" "$(val STRIPE_TEST_$k)"
  done
  sed -i '/^STRIPE_PORTAL_CONFIGURATION=/d;/^STRIPE_BILLING_ENABLED=/d' .env
  echo "rolled back to the sandbox"
elif [ "$1" = "open" ]; then
  put STRIPE_BILLING_ENABLED true
  echo "card billing open to every teacher"
else
  case "$(val STRIPE_SECRET_KEY)" in rk_live_*|sk_live_*) echo "already live"; exit 1;; esac
  for k in SECRET_KEY WEBHOOK_SECRET PRICE_PRO_MONTHLY PRICE_PREMIUM_MONTHLY; do
    put "STRIPE_TEST_$k" "$(val STRIPE_$k)"
    put "STRIPE_$k" "$(val STRIPE_LIVE_$k)"
  done
  put STRIPE_PORTAL_CONFIGURATION "$(val STRIPE_LIVE_PORTAL_CONFIGURATION)"
  sed -i '/^STRIPE_BILLING_ENABLED=/d' .env
  echo "live keys active; billing still gated to admins + testers"
fi
# NO_RESTART=1 leaves the restart to a deploy that follows (one restart, not two).
[ "${NO_RESTART:-}" = "1" ] && { echo "env updated; restart skipped"; exit 0; }
docker compose up -d --force-recreate backend worker 2>&1 | tail -2
for i in $(seq 1 30); do
  a=$(docker compose logs --since 3m backend 2>/dev/null | grep -c "6a372c0c6cd1105ac672ec52 client ready" || true)
  if [ "$a" -ge 1 ]; then echo "WhatsApp number 1 ready after ~$((i*10))s"; break; fi
  sleep 10
done
sleep 15
docker compose logs --since 3m backend 2>/dev/null | grep -E "WHATSAPP" | grep -E "client ready|LOGOUT|giving up" | tail -3
docker compose exec -T backend node -e 'const s=require("./config/stripe");const k=process.env.STRIPE_SECRET_KEY||"";console.log("mode:", k.includes("_live_")?"LIVE":"sandbox", "| open to all:", s.billingOpen(), "| portal:", s.portalConfiguration()||"(default)", "| prices set:", !!s.priceForPlan("pro") && !!s.priceForPlan("premium"))'
