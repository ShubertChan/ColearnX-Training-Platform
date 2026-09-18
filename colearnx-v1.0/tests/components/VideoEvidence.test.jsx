import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import VideoEvidence from "../../src/components/video/VideoEvidence";

test("rounded 10 percent never overrides a server rejection", () => {
  render(<VideoEvidence evidence={{ videoVersionId: "old", uniqueContentWatchedSeconds: 10.00001, durationSeconds: 100, watchedRatio: 0.1000001, hasProtectedAttachmentDownload: true, refundEligibility: { eligible: false, code: "PROTECTED_ATTACHMENT_DOWNLOADED" } }} />);
  expect(screen.getByText("Not eligible")).toBeTruthy();
  expect(screen.getByText("PROTECTED_ATTACHMENT_DOWNLOADED")).toBeTruthy();
  expect(screen.getByText("Downloaded")).toBeTruthy();
});
