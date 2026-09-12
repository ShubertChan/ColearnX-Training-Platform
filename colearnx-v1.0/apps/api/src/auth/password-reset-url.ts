/** The deployed React application uses HashRouter, including reset-token parameters. */
export function passwordResetUrl(appOrigin: string, token: string) {
  if (!token) throw new Error('A password reset token is required.');
  const url = new URL('/', appOrigin);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('An HTTP application origin is required.');
  url.hash = `/reset-password?${new URLSearchParams({ token }).toString()}`;
  return url.toString();
}
