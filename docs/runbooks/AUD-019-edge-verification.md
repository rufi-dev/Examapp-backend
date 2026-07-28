# AUD-019 Cloudflare edge verification

Cloudflare Workers Static Assets (`Frontend/wrangler.jsonc` and
`Frontend/public/_headers`) is the sole frontend hosting contract.

Before an authorized deployment, build with the reviewed production API origin
and run the local HTTPS three-browser header/CSP matrix. After authorization:

```sh
curl -sS -D - -o /dev/null https://examopia.com/
```

Require one enforcing CSP plus HSTS, nosniff, frame, referrer and permissions
policies. Exercise login, dashboard, exam, PDF review and the staff builder in
Chromium, Firefox and WebKit with zero CSP violations.

Abort for a missing/duplicate header, unexpected allowed origin, or blocked
required flow. Roll Cloudflare back to the preceding saved asset version; do
not weaken the policy ad hoc. Preserve the report sample and deployment version.
