import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { AuthPage, ForgotPasswordPage } from "../../src/pages/AuthPages";
import { setLanguage } from "../../src/i18n/LanguageContext";

const api = vi.hoisted(() => ({ config: vi.fn(), signIn: vi.fn(), signup: vi.fn(), reset: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ signIn: api.signIn, registerMember: api.signup }) }));
vi.mock("../../src/api/auth", () => ({ getHumanCheckConfig: api.config, requestPasswordReset: api.reset, resetPassword: vi.fn() }));
vi.mock("../../src/components/GoogleSignIn", () => ({ default: () => null }));
let widgets;
const mount = element => render(<MemoryRouter>{element}</MemoryRouter>);
const fill = (input, value) => fireEvent.change(input, { target: { value } });
beforeEach(() => {
  vi.resetAllMocks(); setLanguage("en"); widgets = [];
  api.config.mockResolvedValue({ enabled: true, siteKey: "public-fixture" });
  window.turnstile = { render: vi.fn((_container, options) => { widgets.push(options); return widgets.length; }), remove: vi.fn() };
});
afterEach(() => { delete window.turnstile; });

test("password login consumes its proof on failure and ignores callbacks from the old widget", async () => {
  api.signIn.mockRejectedValue(new Error("Incorrect password"));
  const { container } = mount(<AuthPage />);
  const form = container.querySelector("form");
  const button = screen.getByRole("button", { name: "Sign in", exact: true });
  await waitFor(() => expect(widgets[0]?.action).toBe("login"));
  expect(button.disabled).toBe(true);
  fill(form.querySelector('input[type=email]'), "member@example.test"); fill(form.querySelector('input[type=password]'), "placeholder");
  fireEvent.submit(form); expect(api.signIn).not.toHaveBeenCalled();
  act(() => widgets[0].callback("proof-one")); expect(button.disabled).toBe(false);
  fireEvent.click(button);
  await waitFor(() => expect(widgets).toHaveLength(2));
  expect(api.signIn).toHaveBeenCalledWith({ email: "member@example.test", password: "placeholder", turnstileToken: "proof-one" });
  act(() => widgets[0].callback("stale")); expect(button.disabled).toBe(true);
  act(() => widgets[1].callback("proof-two"));
  act(() => widgets[1]["expired-callback"]()); expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry verification" }));
  await waitFor(() => expect(widgets).toHaveLength(3));
  expect(window.turnstile.remove).toHaveBeenCalledTimes(2);
});

test("registration sends a proof bound to register and never stores it", async () => {
  const { container } = mount(<AuthPage mode="register" />);
  api.signup.mockRejectedValue(new Error("Fixture"));
  const form = container.querySelector("form");
  await waitFor(() => expect(widgets[0]?.action).toBe("register"));
  fill(form.querySelector("input:not([type])"), "Fixture Member");
  fill(form.querySelector('input[type=email]'), "member@example.test");
  for (const input of form.querySelectorAll('input[type=password]')) fill(input, "Weather-Rivers-Book-762");
  for (const input of form.querySelectorAll('input[type=checkbox]')) fireEvent.click(input);
  act(() => widgets[0].callback("registration-proof"));
  fireEvent.submit(form);
  await waitFor(() => expect(api.signup).toHaveBeenCalledWith(expect.objectContaining({ turnstileToken: "registration-proof" })));
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("registration-proof");
});

test("recovery requires the correct widget; a config outage offers retry, and explicitly disabled rollout permits old clients", async () => {
  api.config.mockRejectedValueOnce(new Error("offline"));
  api.reset.mockResolvedValue({});
  const { container } = mount(<ForgotPasswordPage />);
  const form = container.querySelector("form");
  const button = screen.getByRole("button", { name: "Send reset instructions" });
  fill(form.querySelector('input[type=email]'), "member@example.test");
  expect(button.disabled).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Retry verification" }));
  await waitFor(() => expect(widgets[0]?.action).toBe("forgot_password"));
  act(() => widgets[0].callback("reset-proof")); fireEvent.click(button);
  await waitFor(() => expect(api.reset).toHaveBeenCalledWith({ email: "member@example.test", turnstileToken: "reset-proof" }));
  await screen.findByText("If this address is registered, a reset link will arrive shortly.");
  api.config.mockResolvedValue({ enabled: false, siteKey: null });
  mount(<AuthPage />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Sign in", exact: true }).disabled).toBe(false));
});
