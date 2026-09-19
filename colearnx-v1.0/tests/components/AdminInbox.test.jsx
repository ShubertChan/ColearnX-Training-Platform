import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { AdminInboxProvider, useAdminInbox } from "../../src/context/AdminInboxContext";

const mocks = vi.hoisted(() => ({ platform: { authenticated: true, role: "Admin", profile: { id: "admin-a" } }, list: vi.fn() }));
vi.mock("../../src/context/PlatformContext", () => ({ usePlatform: () => mocks.platform }));
vi.mock("../../src/api/pagination", () => ({ listAllPages: (...args) => mocks.list(...args) }));
const request = (id) => ({ id, status: "pending", requestedRole: "trainer", applicant: { displayName: "Alice" } });
function Probe() {
  const inbox = useAdminInbox();
  return <><output data-testid="state">{JSON.stringify({ count: inbox.unreadCount, arrivals: inbox.arrivalCount, errors: inbox.errors, messages: inbox.messages.map((message) => message.id), unavailable: inbox.storageUnavailable })}</output><button onClick={() => inbox.markRead(["role:one"])}>Read one</button><button onClick={inbox.markAllRead}>Read all</button></>;
}
const state = () => JSON.parse(screen.getByTestId("state").textContent);
const mount = () => render(<AdminInboxProvider><Probe /></AdminInboxProvider>);
beforeEach(() => {
  localStorage.clear(); mocks.list.mockReset();
  mocks.platform = { authenticated: true, role: "Admin", profile: { id: "admin-a" } };
  mocks.list.mockImplementation(async (path) => path.endsWith("role-applications") ? [request("one")] : []);
});

test("initial pending mail has a badge without an arrival toast; reading survives remount", async () => {
  const view = mount();
  await waitFor(() => expect(state().count).toBe(1));
  expect(state().arrivals).toBe(0);
  fireEvent.click(screen.getByText("Read one"));
  expect(state().count).toBe(0);
  view.unmount(); mount();
  await waitFor(() => expect(state().messages).toEqual(["role:one"]));
  expect(state().count).toBe(0);
});

test("polling detects new requests and keeps previous mail when one queue fails", async () => {
  vi.useFakeTimers(); mount();
  await act(async () => {});
  expect(state().count).toBe(1);
  mocks.list.mockImplementation(async (path) => {
    if (path.endsWith("role-applications")) return [request("one"), request("two")];
    return [];
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(state().count).toBe(2); expect(state().arrivals).toBe(1);
  mocks.list.mockImplementation(async (path) => { if (path.endsWith("role-applications")) throw new Error("offline"); return []; });
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(state().count).toBe(2); expect(state().errors).toEqual(["Role applications"]);
});

test("changing admin accounts resets read state and ignores previous account responses", async () => {
  const view = mount(); await waitFor(() => expect(state().count).toBe(1));
  fireEvent.click(screen.getByText("Read all")); expect(state().count).toBe(0);
  let finish;
  mocks.list.mockImplementation((path) => path.endsWith("role-applications") ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve([]));
  fireEvent(window, new Event("focus"));
  mocks.platform = { ...mocks.platform, profile: { id: "admin-b" } };
  mocks.list.mockImplementation(async (path) => path.endsWith("role-applications") ? [request("one")] : []);
  view.rerender(<AdminInboxProvider><Probe /></AdminInboxProvider>);
  await waitFor(() => expect(state().count).toBe(1));
  await act(async () => { finish([request("old-account")]); });
  expect(state().messages).toEqual(["role:one"]);
});

test("member workspace does not fetch or display administrator mail", async () => {
  mocks.platform.role = "Member"; mount();
  await act(async () => {});
  expect(mocks.list).not.toHaveBeenCalled(); expect(state().count).toBe(0);
});

test("focus refresh reflects reviewed requests without treating read status as approval", async () => {
  mount(); await waitFor(() => expect(state().count).toBe(1));
  mocks.list.mockImplementation(async (path) => path.endsWith("role-applications") ? [{ ...request("one"), status: "approved" }] : []);
  fireEvent(window, new Event("focus"));
  await waitFor(() => expect(state().count).toBe(0));
  expect(state().messages).toEqual(["role:one"]);
  expect(localStorage.length).toBe(0);
});

test("denied storage still allows reading mail for the current tab", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  mount(); await waitFor(() => expect(state().count).toBe(1));
  fireEvent.click(screen.getByText("Read one"));
  expect(state().count).toBe(0); expect(state().unavailable).toBe(true);
});
