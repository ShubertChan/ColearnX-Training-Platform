import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import { setLanguage } from "../../src/i18n/LanguageContext";

const mocks = vi.hoisted(() => ({ users: vi.fn(), user: vi.fn(), refresh: vi.fn() }));
vi.mock("../../src/api/admin", () => ({ getAdminUsers: (...args) => mocks.users(...args), getAdminUser: (...args) => mocks.user(...args), deleteAdminUser: vi.fn(), reinstateAdminUser: vi.fn(), setAdminUserRole: vi.fn(), suspendAdminUser: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => ({ adminTrainerCertifications: [], refreshAdminQueues: mocks.refresh, decideTrainerCertification: vi.fn() }) }));
import { AdminUsersPage, AdminUserDetailPage } from "../../src/pages/AdminUserManagementPages";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.refresh.mockResolvedValue(undefined);
});

for (const language of ["en", "zh-CN"]) {
  test(`populated users and account detail render all status badges in ${language}`, async () => {
    setLanguage(language);
    const users = ["active", "suspended", "deleted"].map(status => ({ id: status, displayName: `User ${status}`, email: `${status}@example.test`, status, roles: ["member"], profile: { fullName: `User ${status}` }, createdAt: "2026-10-01T00:00:00Z" }));
    mocks.users.mockResolvedValue({ items: users, total: users.length, hasNext: false });
    mocks.user.mockResolvedValue(users[1]);
    render(<MemoryRouter initialEntries={["/admin/users"]}><Routes>
      <Route path="/admin/users" element={<AdminUsersPage />} />
      <Route path="/admin/users/:userId" element={<AdminUserDetailPage />} />
    </Routes></MemoryRouter>);
    await screen.findByText("User active");
    expect(screen.getByText(language === "en" ? "Active" : "有效", { selector: ".badge" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /User / })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /User suspended/ }));
    await screen.findByRole("heading", { name: "User suspended" });
    expect(mocks.user).toHaveBeenCalledWith("suspended");
    expect(screen.getByRole("button", { name: language === "en" ? "Reinstate account" : "恢复账户" })).toBeTruthy();
  });
}
