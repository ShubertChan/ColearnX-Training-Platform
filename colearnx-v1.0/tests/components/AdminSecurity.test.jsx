import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, expect, test, vi } from "vitest";
import StepUpProvider from "../../src/components/StepUpProvider";
import AdminMfaGate from "../../src/components/AdminMfaGate";
import { clearStepUpAuthorization, withStepUp } from "../../src/api/stepUp.js";

const mocks = vi.hoisted(()=>({verify:vi.fn(),status:vi.fn()}));
vi.mock("../../src/api/auth",()=>({requestStepUp:(...args)=>mocks.verify(...args),getMfaStatus:()=>mocks.status()}));
beforeEach(()=>{clearStepUpAuthorization(); mocks.verify.mockReset(); mocks.status.mockReset();});
const mount = child=>render(<MemoryRouter>{child}</MemoryRouter>);

test("administrator pages guide unenrolled users to security settings and do not mount business actions",async()=>{
  mocks.status.mockResolvedValue({enrolled:false});
  mount(<AdminMfaGate><p>Private queue</p></AdminMfaGate>);
  expect(await screen.findByText("Set up two-factor authentication")).not.toBeNull();
  expect(screen.queryByText("Private queue")).toBeNull();
  expect(screen.getByRole("link",{name:"Open security settings"}).getAttribute("href")).toBe("/security");
});

test("security status failures have a retry and enrolled administrators see the page",async()=>{
  mocks.status.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({enrolled:true});
  mount(<AdminMfaGate><p>Private queue</p></AdminMfaGate>);
  fireEvent.click(await screen.findByRole("button",{name:"Retry security check"}));
  expect(await screen.findByText("Private queue")).not.toBeNull();
});

test("wrong factor stays in the modal; successful verification executes once and can preview another file",async()=>{
  mocks.verify.mockRejectedValueOnce(new Error("That code is not valid.")).mockResolvedValue({stepUpToken:"proof",expiresInSeconds:300});
  mount(<StepUpProvider><p>Workspace</p></StepUpProvider>);
  const action=vi.fn(async token=>token);
  let operation;
  await act(async()=>{operation=withStepUp(action); operation.catch(()=>{});});
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Authenticator or recovery code/),{target:{value:"123456"}});
  fireEvent.click(screen.getByRole("button",{name:"Verify and continue"}));
  expect((await screen.findByRole("alert")).textContent).toContain("That code is not valid.");
  expect(action).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText(/Authenticator or recovery code/),{target:{value:"654321"}});
  fireEvent.click(screen.getByRole("button",{name:"Verify and continue"}));
  await act(async()=>{expect(await operation).toBe("proof");});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(action).toHaveBeenCalledTimes(1);
  expect(await withStepUp(async token=>token)).toBe("proof");
  expect(mocks.verify).toHaveBeenCalledTimes(2);
});

test("cancel and sign-out never replay a pending administrator mutation",async()=>{
  mount(<StepUpProvider />);
  const action=vi.fn(); let operation;
  await act(async()=>{operation=withStepUp(action).catch(error=>error.code);});
  fireEvent.click(screen.getByRole("button",{name:"Cancel"}));
  expect(await operation).toBe("STEP_UP_CANCELLED");
  await act(async()=>{operation=withStepUp(action).catch(error=>error.code);});
  await act(async()=>{clearStepUpAuthorization();});
  expect(await operation).toBe("SESSION_CHANGED");
  await waitFor(()=>expect(screen.queryByRole("dialog")).toBeNull());
  expect(action).not.toHaveBeenCalled();
});
