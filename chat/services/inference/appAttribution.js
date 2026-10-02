// OpenRouter app attribution.
//
// OpenRouter groups traffic into "apps" by these two headers (shown on its
// Top Apps rankings and in our own OpenRouter activity). They identify the
// client, never the user: every OA Chat install sends the same fixed values,
// so they add nothing that tells one user's requests apart from another's.
// The referer is a constant (not window.location.origin) so staging, previews
// and the production domain all count as one app and no hostname leaks.
export const OPENROUTER_APP_URL = 'https://chat.openanonymity.ai';
export const OPENROUTER_APP_TITLE = 'OA Chat';

export const OPENROUTER_APP_HEADERS = Object.freeze({
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-Title': OPENROUTER_APP_TITLE
});
