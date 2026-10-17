# English / Simplified Chinese and page refresh

The frontend now offers English and 简体中文 in the public header, workspace header, and authentication screens. English remains the default. The language preference is stored under `colearnx.language` in local storage, synchronised across tabs, and applied to the document language, title, and displayed dates. If storage is unavailable, switching still works for the current tab.

The switch updates React subscribers without remounting the route, form, dialog, or video player. UI copy lives in `src/i18n/zh-CN.json`; English source phrases are translation keys. Use `const { t } = useTranslation()` in rendering components and named parameters for variable text:

```jsx
const { t } = useTranslation();
return <p>{t("Welcome, {name}.", { name: profile.name })}</p>;
```

Notifications may use `{ key, values }` descriptors so an already-visible notification can change languages. Missing keys fall back to the original English. Unknown server-provided messages also retain their original text. User names, authored course titles/descriptions, files and submitted form values are not automatically translated. Stored purchase-policy records remain unchanged; known policy presentation phrases can be translated. Displayed role/status labels change language while their permission identifiers, option values and API payloads remain unchanged.

The home page now has a quieter welcome section, one balance summary, two activity metrics and clearly separated shortcuts. Course details separate the overview, author, description, delivery/refund details and purchase summary. The purchase summary stays visible alongside the content on desktop, and follows the overview on mobile. Existing purchase restrictions and refund-policy checks are preserved.

## Top-up return behaviour

The existing main branch already keeps loaded wallet content mounted during background refreshes. The regression suite verifies that paid-return reconciliation runs once and never replaces the wallet with its initial loading placeholder.

This update also distinguishes a confirmed payment from a failed secondary wallet refresh. On refresh failure it clears the payment return parameter, keeps the existing page visible, and offers **Retry wallet refresh**. The retry only reads wallet data; it does not create another checkout or recheck/replay the confirmed payment. Failed, cancelled and expired payments stop polling and never produce a points-added notification. Language switching during verification does not restart the payment check.

## Validation — 16 October 2026 (Singapore)

- `npm test`: 164 tests passed.
- `npm run test:components`: 61 tests passed, including language/input preservation, cross-tab changes, original role values and payment reconciliation.
- `npm exec -- playwright test --config playwright.review.config.js`: all 65 browser tests passed in the final combined run (56 existing and 9 added).
- The additional tests in `tests/e2e/language-wallet.spec.js` cover English and Chinese at 375, 768 and 1440 pixels, cart actions, reload persistence, failed wallet refresh without loading-placeholder replacements, and terminal payment states.
- Production build passed. The existing large-chunk advisory remains.
- `npm run check:i18n` checks every literal translation key in JSX and interpolation parameter parity in the Chinese catalog.

Browser tests used the project's local Chrome configuration and isolated API fixtures. Visual checks used representative local sample data. These checks do not exercise a live Stripe charge, webhook infrastructure, or production account.
