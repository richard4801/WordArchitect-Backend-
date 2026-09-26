import { Router, type Request, type Response } from "express";
import { signup, login, getUserFromToken, changePassword, ValidationError, ConflictError, AuthError } from "../services/auth.js";

export const authRouter = Router();

function handleAuthError(err: unknown, res: Response): void {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof AuthError) {
    res.status(401).json({ error: err.message });
    return;
  }
  console.error("auth request failed:", err);
  res.status(502).json({ error: "Authentication request failed." });
}

// POST /api/v1/auth/signup
// { email, password, displayName?, claimUserId? } -- claimUserId lets a
// signup adopt a pre-existing user_id that already owns real books/Codex
// data from before this backend had accounts (see auth.ts). Omit it for a
// normal brand-new account.
authRouter.post("/auth/signup", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    res.status(400).json({ error: "email and password are required." });
    return;
  }
  if (body.displayName !== undefined && typeof body.displayName !== "string") {
    res.status(400).json({ error: "displayName must be a string." });
    return;
  }
  if (body.claimUserId !== undefined && typeof body.claimUserId !== "string") {
    res.status(400).json({ error: "claimUserId must be a string." });
    return;
  }

  try {
    const params: Parameters<typeof signup>[0] = { email: body.email, password: body.password };
    if (body.displayName !== undefined) params.displayName = body.displayName;
    if (body.claimUserId !== undefined) params.claimUserId = body.claimUserId;
    const { user, token } = await signup(params);
    res.status(201).json({ user, token });
  } catch (err) {
    handleAuthError(err, res);
  }
});

// POST /api/v1/auth/login
// { email, password } -> { user, token }
authRouter.post("/auth/login", async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.email !== "string" || typeof body.password !== "string") {
    res.status(400).json({ error: "email and password are required." });
    return;
  }

  try {
    const { user, token } = await login({ email: body.email, password: body.password });
    res.json({ user, token });
  } catch (err) {
    handleAuthError(err, res);
  }
});

// GET /api/v1/auth/me
// Authorization: Bearer <token> -> { user }. What the frontend calls on
// load to turn a persisted token back into the real, cross-device userId
// -- the actual fix for identity that used to live only in one browser's
// local storage.
authRouter.get("/auth/me", async (req: Request, res: Response) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header." });
    return;
  }

  try {
    const user = await getUserFromToken(token);
    res.json({ user });
  } catch (err) {
    handleAuthError(err, res);
  }
});

// PATCH /api/v1/auth/me
// Authorization: Bearer <token>, { password } -> { user }. Possession of a
// valid token is treated as sufficient to set a new password -- no
// current-password confirmation, the normal "change password while
// logged in" pattern. There's no email/reset flow yet, so this is also
// the only way to correct a password entered by mistake.
authRouter.patch("/auth/me", async (req: Request, res: Response) => {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    res.status(401).json({ error: "Missing Authorization: Bearer <token> header." });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  if (typeof body.password !== "string") {
    res.status(400).json({ error: "password is required." });
    return;
  }

  try {
    const user = await changePassword(token, body.password);
    res.json({ user });
  } catch (err) {
    handleAuthError(err, res);
  }
});
