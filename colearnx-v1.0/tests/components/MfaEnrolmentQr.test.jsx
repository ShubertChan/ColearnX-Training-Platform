import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";

const m = vi.hoisted(() => ({
  getMfaStatus: vi.fn(),
  listSessions: vi.fn(),
  startMfaEnrolment: vi.fn(),
  confirmMfaEnrolment: vi.fn(),
  disableMfa: vi.fn(),
  rotateRecoveryCodes: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
}));
vi.mock("../../src/api/auth", () => m);

import { SecuritySettingsPage } from "../../src/pages/SecurityPages";

beforeEach(() => {
  Object.values(m).forEach((fn) => fn.mockReset());
  m.listSessions.mockResolvedValue({ sessions: [] });
});

test("enrolment shows a scannable QR code with the manual key kept as a fallback", async () => {
  m.getMfaStatus.mockResolvedValue({ enrolled: false, pending: false, confirmedAt: null, recoveryCodesRemaining: 0 });
  m.startMfaEnrolment.mockResolvedValue({
    secret: "JBSWY3DPEHPK3PXP",
    otpauthUri: "otpauth://totp/CoLearnX:a@b.com?secret=JBSWY3DPEHPK3PXP&issuer=CoLearnX",
  });

  const { container } = render(
    <MemoryRouter>
      <SecuritySettingsPage />
    </MemoryRouter>
  );

  fireEvent.click(await screen.findByRole("button", { name: /Turn on two-factor authentication/ }));

  // The scan-first instruction and the rendered QR are present...
  expect(await screen.findByText(/Scan this QR code/)).toBeTruthy();
  await waitFor(() => expect(container.querySelector(".mfa-qr svg")).not.toBeNull());
  // ...and the manual setup key stays as a fallback.
  expect(screen.getByDisplayValue("JBSWY3DPEHPK3PXP")).toBeTruthy();
});
