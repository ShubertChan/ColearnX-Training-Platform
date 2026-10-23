# Onsite points checkout

The wallet top-up flow now opens `/wallet/checkout/:paymentTransactionId` inside CoLearnX. Contact information comes first, followed by the card/PayNow accordion, then the available Apple Pay / Link / Google Pay buttons, and the payment button. Wallet availability is determined by Stripe, the registered domain, device and browser. An unavailable express-payment section is hidden.

Stripe Elements collects payment data directly. CoLearnX continues to create the order and fixed amount on the server, and only the verified Stripe webhook credits points. The client returns to the existing wallet reconciliation flow after confirmation; it never adds points itself.

## Deployment

1. Deploy the API and frontend together. The API must have matching sandbox `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, plus the existing `STRIPE_WEBHOOK_SECRET` and correct `APP_ORIGIN`. A missing publishable key rejects onsite checkout before creating an order. No secret key belongs in frontend environment variables.
2. Keep `VITE_PAYMENTS_API_ENABLED=true`. The production `_headers` generator uses this flag to allow Stripe scripts/frames, Link authentication, wallet permissions and payment popups. Deploy the generated headers with the client.
3. In the same Stripe sandbox, enable Card, PayNow and Link. PayNow is requested only for SGD; Apple Pay and Google Pay use the card payment method. Register the deployed HTTPS hostname under Stripe **Settings → Payment method domains**, including any preview hostname used to test wallets. A hosted `checkout.stripe.com` integration does not register the site's own domain.
4. Keep the existing `checkout.session.completed` webhook subscription and validate a test payment end to end: one paid top-up, one points credit, balanced ledger entries and a processed webhook. Replaying the webhook must not duplicate the credit.
5. Check Card success/decline/3DS, PayNow QR payment, Apple Pay on a supported device, and Link authentication in the deployed sandbox. Verify refresh, Back to wallet, expired sessions, and English/Chinese on mobile. No live charge is needed.

## Session behavior

- The create endpoint accepts `uiMode: "elements"` and `locale: "en" | "zh"`. Older clients that omit `uiMode` retain the hosted checkout response.
- `GET /wallet/top-ups/:id/checkout-session` authenticates ownership before retrieving a Stripe session. It rejects foreign, expired, live-mode or mismatched sessions and uses `Cache-Control: no-store`.
- Client secrets are returned only for open owned sessions, held in memory, and never persisted in URLs, browser storage or idempotency records. Refresh reloads the same session by payment transaction ID. Switching accounts discards the in-memory session.
- Repeat submission is guarded in both the package modal and payment form; uncertain create requests retain their idempotency key while the modal remains open. Card and express confirmations share the same Stripe session.
- Fixed top-up prices disable Adaptive Pricing so currency/amount checks remain authoritative.

## Automated verification

Run `npm test`, `npm run test:components`, `npm run api:test`, `npm run api:typecheck`, `npm run check:i18n`, and `npm run build`. Run `npx playwright test tests/e2e/top-up-checkout.spec.js` for the checkout flow and layout across browsers.

Stripe API calls and payment UI are mocked in automated tests, as recommended by [Stripe's automated testing guide](https://docs.stripe.com/automated-testing). These checks cover ownership, session metadata/amount matching, expiration, fixed pricing, secret handling, duplicate submissions, declines/retries, wallet fallback, refresh, layout and reconciliation. They do not certify actual wallet availability or a real Stripe/PayNow/3DS transaction; complete the deployed sandbox checks above before release.

Verified for this change: frontend unit tests 179 passed; component tests 81 passed; API tests 287 passed with 1 existing optional test skipped; frontend/API builds, API typecheck and Chinese catalog validation passed. Checkout browser tests passed in Chromium (7) and WebKit (7), covering 1440/768/390px in English and Chinese. WebKit was run with one worker on Windows. Firefox could not launch on the verification machine (`browserType.launch: spawn UNKNOWN`), so Firefox compatibility remains unverified.

References: [Checkout Elements](https://docs.stripe.com/payments/quickstart), [Express Checkout](https://docs.stripe.com/elements/express-checkout-element), [payment method domains](https://docs.stripe.com/payments/payment-methods/pmd-registration), [Stripe CSP requirements](https://docs.stripe.com/security/guide).
