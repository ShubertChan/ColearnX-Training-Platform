import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import LanguageSwitcher from "../../src/components/LanguageSwitcher";
import { LanguageEffects, setLanguage } from "../../src/i18n/LanguageContext";
import { LANGUAGE_STORAGE_KEY, readLanguage, translateText } from "../../src/i18n/locale";

const mocks = vi.hoisted(() => ({ addToCart: vi.fn(), setRole: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({
  signIn: vi.fn(), completeSignIn: vi.fn(), registerMember: vi.fn(),
  courses: [{ id: "course", title: "Home", description: "An English description", trainer: "Alex", category: "Design", deliveryModes: ["live"], price: 100, purchaseEnabled: true, refundPolicyPreview: { summary: "Original purchase terms" } }],
  cart: [], authenticated: true, canPurchase: true, courseCatalogState: { status: "ready" },
  role: "Member", approvedRoles: ["Member", "Trainer"], balance: 1000,
  profile: { name: "Jamie" }, dataErrors: {}, toast: "", setRole: mocks.setRole, addToCart: mocks.addToCart,
}) }));
vi.mock("../../src/context/AdminInboxContext", () => ({ useAdminInbox: () => ({ unreadCount: 0, errors: [], arrivalCount: 0, dismissArrival: vi.fn() }) }));
import { AuthPage } from "../../src/pages/AuthPages";
import { CourseDetailPage, CourseMarketplacePage } from "../../src/pages/MarketplacePlatformPages";
import Layout from "../../src/components/Layout";

beforeEach(() => {
  setLanguage("en");
  mocks.addToCart.mockClear(); mocks.setRole.mockClear();
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => { act(() => setLanguage("en")); });

test("saved language validates input and blocked storage falls back to English", () => {
  expect(readLanguage({ getItem: () => "zh-CN" })).toBe("zh-CN");
  expect(readLanguage({ getItem: () => "unknown" })).toBe("en");
  expect(readLanguage({ getItem: () => { throw new Error("blocked"); } })).toBe("en");
  expect(translateText("Missing phrase", "zh-CN")).toBe("Missing phrase");
  expect(translateText(" ", "zh-CN")).toBe(" ");
  expect(translateText("{0} points", "zh-CN", { 0: 15 })).toBe("15 积分");
  expect(translateText({ key: "{points} points have been added to your wallet.", values: { points: 500 } }, "zh-CN")).toBe("500 积分已充值到您的钱包。");
});

test("switching language preserves typed login fields and persists across reload initialization", () => {
  render(<MemoryRouter><LanguageEffects /><AuthPage /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "learner@example.test" } });
  fireEvent.change(screen.getByLabelText("Password", { selector: "input" }), { target: { value: "private test input" } });
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  expect(screen.getByRole("heading", { name: "登录 CoLearnX" })).not.toBeNull();
  expect(screen.getByLabelText("电子邮箱").value).toBe("learner@example.test");
  expect(screen.getByLabelText("密码", { selector: "input" }).value).toBe("private test input");
  expect(document.documentElement.lang).toBe("zh-CN");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");
  expect(readLanguage()).toBe("zh-CN");
  fireEvent.change(screen.getByRole("combobox", { name: "语言" }), { target: { value: "en" } });
  expect(screen.getByRole("heading", { name: "Sign in to CoLearnX" })).not.toBeNull();
  expect(screen.getByLabelText("Email address").value).toBe("learner@example.test");
});

test("Chinese role labels retain original permission values and route identities", () => {
  render(<MemoryRouter><Layout><p>Workspace</p></Layout></MemoryRouter>);
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  const roleSelect = screen.getByRole("combobox", { name: "工作区角色" });
  expect(roleSelect.value).toBe("Member");
  fireEvent.change(roleSelect, { target: { value: "Trainer" } });
  expect(mocks.setRole).toHaveBeenCalledWith("Trainer");
  expect(screen.getByRole("link", { name: "课程市场" }).getAttribute("href")).toBe("/courses");
});

test("course content remains original while purchase actions use unchanged identifiers", () => {
  render(<MemoryRouter initialEntries={["/courses/course"]}><LanguageSwitcher /><Routes><Route path="/courses/:id" element={<CourseDetailPage />} /></Routes></MemoryRouter>);
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  expect(screen.getByRole("heading", { name: "Home", exact: true })).not.toBeNull();
  expect(screen.getByText("An English description")).not.toBeNull();
  expect(screen.getByText("Original purchase terms")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "加入购物车" }));
  expect(mocks.addToCart).toHaveBeenCalledWith("course", "course");
});

test("cross-tab language changes propagate without remounting the form", () => {
  render(<MemoryRouter><LanguageEffects /><AuthPage /></MemoryRouter>);
  const field = screen.getByLabelText("Email address");
  fireEvent.change(field, { target: { value: "keep@example.test" } });
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: LANGUAGE_STORAGE_KEY, newValue: "zh-CN" })));
  expect(screen.getByLabelText("电子邮箱")).toBe(field);
  expect(field.value).toBe("keep@example.test");
});

test("translated category options preserve the original filter value and URL", () => {
  render(<MemoryRouter initialEntries={["/courses?category=Design"]}><LanguageSwitcher /><CourseMarketplacePage /></MemoryRouter>);
  fireEvent.change(screen.getByRole("combobox", { name: "Language" }), { target: { value: "zh-CN" } });
  const filter = screen.getByRole("combobox", { name: "筛选课程类别" });
  expect(filter.value).toBe("Design");
  expect(screen.getByRole("option", { name: "设计" }).value).toBe("Design");
  expect(screen.getByRole("heading", { name: "Home" })).not.toBeNull();
  fireEvent.change(filter, { target: { value: "" } });
  fireEvent.change(filter, { target: { value: "Design" } });
  expect(screen.getByRole("heading", { name: "Home" })).not.toBeNull();
});

test("nested presentation values translate but names and embedded placeholders remain literal", () => {
  const notice = { key: "{role} application submitted for administrator review.", values: { role: { key: "Trainer" } } };
  expect(translateText(notice, "zh-CN")).toBe("讲师申请已提交管理员审核。");
  expect(translateText(notice, "en")).toBe("Trainer application submitted for administrator review.");
  expect(translateText("Welcome, {name}.", "zh-CN", { name: "Home {role} <script>" })).toBe("欢迎，Home {role} <script>。");
});
