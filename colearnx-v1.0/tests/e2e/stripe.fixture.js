// Stripe recommends mocking its client for automated tests. This fixture tests
// our layout and SDK callbacks; it does not claim to verify real wallet availability.
import { fileURLToPath } from "node:url";

export async function mockStripe(page, wallets = true) {
  await page.addInitScript(({ wallets }) => {
    window.__stripeFixture = { wallets, confirms: 0, decline: false };
    window.__paymentCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.__paymentCspViolations.push(event.blockedURI));
  }, { wallets });
  await page.route("**/__fixture/stripe.css", route => route.fulfill({
    contentType: "text/css", path: fileURLToPath(new URL("./stripe.fixture.css", import.meta.url)),
  }));
  await page.route("https://js.stripe.com/**", route => route.fulfill({ contentType: "application/javascript", body: `(${stripeFixture.toString()})()` }));
}

function stripeFixture() {
  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "/__fixture/stripe.css";
  document.head.append(css);
  window.Stripe = function (_key, { locale }) {
    const zh = locale === "zh";
    const state = window.__stripeFixture;
    const noop = () => {};
    function element(type) {
      const handlers = {};
      let container;
      const emit = (name, value) => handlers[name]?.(value);
      return {
        on(name, fn) { handlers[name] = fn; },
        off(name) { delete handlers[name]; },
        update() {},
        destroy() { if (container) container.replaceChildren(); },
        mount(node) {
          container = node;
          node.dataset.testid = type === "payment" ? "stripe-payment-fixture" : "stripe-express-fixture";
          if (type === "payment") {
            node.innerHTML = `<div class="fixture-card"><div class="fixture-method">
              <label class="fixture-radio"><input type="radio" name="fixture-method" checked> ${zh ? "银行卡" : "Card"} <span>VISA · Mastercard</span></label>
              <div class="fixture-fields"><label>${zh ? "卡号" : "Card number"}<input aria-label="Test card number" value="4242 4242 4242 4242"></label>
              <div><input aria-label="Test expiry" value="12 / 30"><input aria-label="Test CVC" value="123"></div></div></div>
              <label class="fixture-radio"><input type="radio" name="fixture-method">PayNow</label></div>`;
          } else if (state.wallets) {
            node.innerHTML = '<div class="fixture-wallets"><button type="button" data-wallet="apple">Apple Pay</button><button type="button" data-wallet="link">link</button></div>';
            node.querySelectorAll("button").forEach(button => button.addEventListener("click", () => emit("confirm", { paymentFailed: noop })));
          }
          setTimeout(() => {
            emit("ready", type === "payment" ? {} : { availablePaymentMethods: state.wallets ? { applePay: true, link: true } : undefined });
            if (type === "payment") emit("change", { complete: true });
          }, 100);
        },
      };
    }
    const actions = {
      getSession: () => ({}),
      async confirm() {
        state.confirms++;
        return state.decline ? { type: "error", error: { message: zh ? "银行卡被拒绝，请使用其他支付方式。" : "Your card was declined." } } : { type: "success", session: {} };
      },
    };
    return {
      elements: noop, createToken: noop, createPaymentMethod: noop, confirmCardPayment: noop,
      _registerWrapper: noop, registerAppInfo: noop,
      initCheckoutElementsSdk: () => ({
        on: noop, loadActions: async () => ({ type: "success", actions }),
        createPaymentElement(options) {
          // Mirror the SDK contract: a permissive fixture previously hid the
          // production IntegrationError caused by layout.radios: true.
          const radios = options?.layout?.radios;
          if (radios !== undefined && !["always", "never", "auto", "if_multiple"].includes(radios)) {
            throw new Error("Invalid createPaymentElement options.layout.radios");
          }
          return element("payment");
        },
        createExpressCheckoutElement: () => element("express"),
      }),
    };
  };
  window.Stripe.version = "endive";
}
