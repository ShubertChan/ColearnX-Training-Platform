// Stripe recommends mocking its client for automated tests. This fixture tests
// our layout and SDK callbacks; it does not claim to verify real wallet availability.
export async function mockStripe(page, wallets = true) {
  await page.addInitScript(({ wallets }) => {
    window.__stripeFixture = { wallets, confirms: 0, decline: false };
    window.__paymentCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.__paymentCspViolations.push(event.blockedURI));
  }, { wallets });
  await page.route("https://js.stripe.com/**", route => route.fulfill({ contentType: "application/javascript", body: `(${stripeFixture.toString()})()` }));
}

function stripeFixture() {
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
            node.innerHTML = `<div style="border:1px solid #e3e8f1;border-radius:8px;font:14px system-ui;color:#172033"><div style="padding:16px;border-bottom:1px solid #e3e8f1"><label style="display:flex;align-items:center;gap:12px"><input type="radio" name="fixture-method" checked> ${zh ? "银行卡" : "Card"} <span style="margin-left:auto;color:#4057d6;font-size:12px">VISA · Mastercard</span></label><div style="display:grid;gap:8px;margin-top:16px"><label>${zh ? "卡号" : "Card number"}<input aria-label="Test card number" value="4242 4242 4242 4242" style="width:100%;padding:12px;margin-top:8px;border:1px solid #c8ced8;border-radius:6px"></label><div style="display:flex;gap:12px"><input aria-label="Test expiry" value="12 / 30" style="width:50%;padding:12px;border:1px solid #c8ced8;border-radius:6px"><input aria-label="Test CVC" value="123" style="width:50%;padding:12px;border:1px solid #c8ced8;border-radius:6px"></div></div></div><label style="display:flex;align-items:center;gap:12px;padding:16px"><input type="radio" name="fixture-method">PayNow</label></div>`;
            node.querySelectorAll('input[type="radio"]').forEach(input => { input.style.cssText = "width:18px;height:18px;min-height:0;flex:0 0 18px;margin:0;padding:0"; });
          } else if (state.wallets) {
            node.innerHTML = '<div style="display:flex;gap:12px"><button type="button" data-wallet="apple" style="flex:1;min-height:48px;background:#000;color:white;border:0;border-radius:8px;font:600 20px system-ui">Apple Pay</button><button type="button" data-wallet="link" style="flex:1;min-height:48px;background:#00d66f;color:#003b22;border:0;border-radius:8px;font:700 24px system-ui">link</button></div>';
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
      initCheckoutElementsSdk: () => ({ on: noop, loadActions: async () => ({ type: "success", actions }), createPaymentElement: () => element("payment"), createExpressCheckoutElement: () => element("express") }),
    };
  };
  window.Stripe.version = "endive";
}
