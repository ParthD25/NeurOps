// Real numbers from the Fireline 9-week model lifecycle (data/lifecycle.json):
// average prep-time error of the model in production, by week, in seconds.
// Regenerate after `npm run lifecycle` if the model changes.
export const WEEKLY_ERROR = [31.6, 31.5, 26.6, 22.1, 24.6, 29.0, 21.4, 21.4, 22.3];
export const FIRST_3_WEEKS = 29.9;
export const LAST_3_WEEKS = 21.7;
export const CHANGE_PCT = Math.round(((LAST_3_WEEKS - FIRST_3_WEEKS) / FIRST_3_WEEKS) * 100); // -27
