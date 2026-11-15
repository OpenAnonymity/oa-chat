// OpenRouter app attribution.
//
// OpenRouter groups traffic into "apps" by these two headers (shown on its
// Top Apps rankings and in our own OpenRouter activity). These fixed values
// identify the app/cohort, not an account, device or conversation. Using a
// constant instead of window.location avoids sending deployment hostnames,
// paths or query strings. Other network/content metadata remains observable.
export const OPENROUTER_APP_URL = 'https://chat.openanonymity.ai';
export const OPENROUTER_APP_TITLE = 'OA Chat';

export const OPENROUTER_APP_HEADERS = Object.freeze({
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-Title': OPENROUTER_APP_TITLE
});
