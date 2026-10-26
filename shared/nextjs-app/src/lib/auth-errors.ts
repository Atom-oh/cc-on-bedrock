// Sign-in error code thrown by the credentials provider (lib/auth.ts) that the
// client login page turns into a follow-up form. Kept separate so the client
// bundle does not import the server-side auth options.
export const NEW_PASSWORD_REQUIRED = "NEW_PASSWORD_REQUIRED";
