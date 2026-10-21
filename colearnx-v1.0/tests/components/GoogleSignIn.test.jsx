import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { setLanguage } from '../../src/i18n/LanguageContext';

const mocks = vi.hoisted(() => ({ config: vi.fn(), challenge: vi.fn(), load: vi.fn(), signIn: vi.fn(), initialize: vi.fn(), renderButton: vi.fn() }));
vi.mock('../../src/api/googleIdentity', () => ({ getGoogleConfig: mocks.config, createGoogleChallenge: mocks.challenge, loadGoogleIdentity: mocks.load }));
vi.mock('../../src/context/PlatformContext', () => ({ usePlatform: () => ({ signInWithGoogle: mocks.signIn }) }));
import GoogleSignIn from '../../src/components/GoogleSignIn';

beforeEach(() => {
  vi.clearAllMocks(); setLanguage('en');
  mocks.config.mockResolvedValue({ enabled: true, clientId: 'fixture.apps.googleusercontent.com' });
  mocks.challenge.mockResolvedValue({ nonce: 'nonce', expiresAt: new Date(Date.now() + 600000).toISOString() });
  mocks.load.mockResolvedValue({ initialize: mocks.initialize, renderButton: mocks.renderButton });
});
afterEach(() => { act(() => setLanguage('en')); });
async function setup(props = {}) {
  const rendered = render(<MemoryRouter><GoogleSignIn {...props} /></MemoryRouter>);
  await waitFor(() => expect(mocks.renderButton).toHaveBeenCalled());
  return rendered;
}
const credential = () => mocks.initialize.mock.calls.at(-1)[0].callback({ credential: 'private-id-token' });

test('button switches language without resetting the challenge or enabling automatic login', async () => {
  await setup();
  expect(mocks.initialize.mock.calls[0][0]).toMatchObject({ nonce: 'nonce', auto_select: false, ux_mode: 'popup' });
  expect(mocks.renderButton.mock.calls.at(-1)[1].locale).toBe('en');
  act(() => setLanguage('zh-CN'));
  expect(mocks.renderButton.mock.calls.at(-1)[1].locale).toBe('zh_CN');
  expect(screen.getByLabelText('使用 Google 登录')).toBeTruthy();
  expect(mocks.challenge).toHaveBeenCalledTimes(1);
});
test('new Google users must accept both policies; the credential stays in component memory', async () => {
  const onSignedIn = vi.fn();
  mocks.signIn.mockResolvedValueOnce({ registrationRequired: true }).mockResolvedValueOnce({ roles: ['Member'] });
  await setup({ onSignedIn });
  await act(async () => { await credential(); });
  const create = screen.getByRole('button', { name: 'Create Member account' });
  expect(create.disabled).toBe(true);
  const boxes = screen.getAllByRole('checkbox');
  fireEvent.click(boxes[0]); expect(create.disabled).toBe(true);
  fireEvent.click(boxes[1]); expect(create.disabled).toBe(false);
  await act(async () => { fireEvent.click(create); });
  expect(mocks.signIn.mock.calls[1][0]).toEqual({ credential: 'private-id-token', acceptedTerms: true, ageAcknowledged: true });
  expect(onSignedIn).toHaveBeenCalledWith({ roles: ['Member'] });
  expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('private-id-token');
});
test('MFA continuation reaches the existing MFA screen without creating another login', async () => {
  const onSignedIn = vi.fn();
  mocks.signIn.mockResolvedValue({ mfaRequired: true, mfaToken: 'continuation' });
  await setup({ onSignedIn });
  await act(async () => { await credential(); });
  expect(onSignedIn).toHaveBeenCalledWith({ mfaRequired: true, mfaToken: 'continuation' });
});
test('disabled configuration never loads Google scripts', async () => {
  mocks.config.mockResolvedValue({ enabled: false });
  const { container } = render(<MemoryRouter><GoogleSignIn /></MemoryRouter>);
  await waitFor(() => expect(container.textContent).toBe(''));
  expect(mocks.load).not.toHaveBeenCalled();
});
test('script failure has a translated retry and can recover', async () => {
  mocks.load.mockRejectedValueOnce(new Error('offline'));
  render(<MemoryRouter><GoogleSignIn /></MemoryRouter>);
  await screen.findByRole('alert');
  act(() => setLanguage('zh-CN'));
  expect(screen.getByRole('alert').textContent).toContain('无法加载 Google 登录');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(mocks.renderButton).toHaveBeenCalled());
});
test('duplicate callbacks while submitting are ignored', async () => {
  let finish;
  mocks.signIn.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await setup({ onSignedIn: vi.fn() });
  act(() => { credential(); credential(); });
  expect(mocks.signIn).toHaveBeenCalledTimes(1);
  await act(async () => { finish({ roles: ['Member'] }); });
});
