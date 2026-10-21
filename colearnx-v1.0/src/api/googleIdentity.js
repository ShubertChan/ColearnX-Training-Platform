import { apiClient } from './client';

export const getGoogleConfig = () => apiClient.get('/auth/google/config').then((response) => response.data.data);
export const loginWithGoogle = (input) => apiClient.post('/auth/google', input).then((response) => response.data.data);

let challengePending;
// Serialize initial cookie creation, including React StrictMode mounts.
export function createGoogleChallenge() {
  if (!challengePending) {
    challengePending = apiClient.post('/auth/google/challenge', {}).then((response) => response.data.data)
      .finally(() => { challengePending = null; });
  }
  return challengePending;
}

let scriptPending;
export function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve(window.google.accounts.id);
  if (scriptPending) return scriptPending;
  scriptPending = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.async = true;
    const fail = () => { clearTimeout(timer); script.remove(); reject(new Error('Google sign-in could not load. Check your connection and try again.')); };
    const timer = setTimeout(fail, 15000);
    script.onerror = fail;
    script.onload = () => {
      if (!window.google?.accounts?.id) return fail();
      clearTimeout(timer);
      resolve(window.google.accounts.id);
    };
    document.head.appendChild(script);
  }).catch((error) => { scriptPending = null; throw error; });
  return scriptPending;
}
