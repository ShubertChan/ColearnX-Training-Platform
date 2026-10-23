import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ state: {}, retry: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => mocks.state }));
vi.mock("../../src/pages/AccountPlatformPages", () => ({ HomePage: () => <h1>Private home</h1>, ProfilePage: () => null, PublicProfilePage: () => null }));
vi.mock("../../src/components/Layout", () => ({ default: ({ children }) => <main>{children}</main> }));
import App from "../../src/App";

const mount = (path = "/login") => render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
beforeEach(() => {
  setLanguage("en"); mocks.retry.mockReset();
  mocks.state = { authenticated: false, accountLoading: true, accountError: "", role: "Member", retrySession: mocks.retry, dataStates: {}, orders: [], courseCatalogState: {}, contentCatalogState: {} };
});

test("the login form renders immediately and keeps inputs through recovery and language changes", () => {
  const view = mount();
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "learner@example.test" } });
  fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "local test input" } });
  expect(screen.getByText(/Connecting securely/)).not.toBeNull();
  mocks.state.accountLoading = false; mocks.state.accountError = "offline";
  view.rerender(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Retry connection" })); expect(mocks.retry).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Email address").value).toBe("learner@example.test");
  expect(screen.getByLabelText("Password", { selector: "input" }).value).toBe("local test input");
  act(() => setLanguage("zh-CN"));
  expect(screen.getByRole("button", { name: "重新连接" })).not.toBeNull();
  expect(screen.getByLabelText("电子邮箱").value).toBe("learner@example.test");
  mocks.state.accountError = "";
  view.rerender(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: "重新连接" })).toBeNull();
  expect(screen.getByLabelText("密码", { selector: "input" }).value).toBe("local test input");
  act(() => setLanguage("en"));
});

test("registration remains visible when an optional session check fails", () => {
  mocks.state.accountLoading = false; mocks.state.accountError = "offline";
  mount("/register");
  expect(screen.getByRole("heading", { name: "Create your account" })).not.toBeNull();
  expect(screen.getByLabelText("Full name")).not.toBeNull();
});

test("even a stale authenticated hint cannot redirect a loading or failed session into the workspace", () => {
  mocks.state.authenticated = true;
  const view = mount();
  expect(screen.getByRole("heading", { name: "Sign in to CoLearnX" })).not.toBeNull();
  mocks.state.accountLoading = false; mocks.state.accountError = "offline";
  view.rerender(<MemoryRouter initialEntries={["/login"]}><App /></MemoryRouter>);
  expect(screen.queryByText("Private home")).toBeNull();
});

test("protected pages remain blocked while restoring or after a service failure", () => {
  const view = mount("/home");
  expect(screen.getByText("Restoring your secure session…")).not.toBeNull();
  expect(screen.queryByText("Private home")).toBeNull();
  mocks.state.accountLoading = false; mocks.state.accountError = "offline";
  view.rerender(<MemoryRouter initialEntries={["/home"]}><App /></MemoryRouter>);
  expect(screen.getByText("Session temporarily unavailable")).not.toBeNull();
  expect(screen.queryByText("Private home")).toBeNull();
  mocks.state.accountError = "";
  view.rerender(<MemoryRouter initialEntries={["/home"]}><App /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Sign in to CoLearnX" })).not.toBeNull();
});
