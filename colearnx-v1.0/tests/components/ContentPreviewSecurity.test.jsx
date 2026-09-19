import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { ContentReviewActions } from '../../src/pages/AdminPlatformPages.jsx';

const mocks = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock('../../src/api/admin', async importOriginal => ({ ...await importOriginal(), previewContentSubmission: (...args) => mocks.preview(...args) }));

test('file verification stays in the main tab and popup fallback opens exactly the selected attachment', async () => {
  let finish;
  mocks.preview.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const replace = vi.fn();
  const opened = { opener: {}, location: { replace } };
  const open = vi.spyOn(window, 'open').mockReturnValueOnce(null).mockReturnValueOnce(opened);
  render(<MemoryRouter><ContentReviewActions item={{ id: 'version', assets: [{ assetId: 'asset-a', filename: 'a.pdf', mediaType: 'application/pdf', sizeBytes: 100, status: 'ready' }] }} busy={false} onDecision={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: /1 file/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Preview a.pdf' }));
  expect(open).not.toHaveBeenCalled();
  expect(mocks.preview).toHaveBeenCalledWith('version', 'asset-a');
  await act(async () => finish({ previewUrl: 'https://example.test/a.pdf', expiresAt: new Date(Date.now() + 300000).toISOString() }));
  await waitFor(() => expect(screen.getByText('Open preview')).not.toBeNull());
  expect(screen.getByText('0/1 reviewed')).not.toBeNull();
  fireEvent.click(screen.getByText('Open preview'));
  expect(replace).toHaveBeenCalledWith('https://example.test/a.pdf');
  expect(opened.opener).toBeNull();
  expect(mocks.preview).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText('1/1 reviewed')).not.toBeNull());
  open.mockRestore();
});
