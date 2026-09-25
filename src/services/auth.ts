import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getSupabaseClient } from "../lib/supabaseClient.js";
import { getEnvVar } from "../lib/env.js";

const BCRYPT_ROUNDS = 10;
// Long-lived, no refresh flow -- this is a single-account app today, not
// worth a refresh-token mechanism until there's a real reason to rotate.
const TOKEN_TTL = "90d";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface AuthUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
}

function toAuthUser(row: UserRow): AuthUser {
  return { id: row.id, email: row.email, displayName: row.display_name, createdAt: row.created_at };
}

function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email }, getEnvVar("JWT_SECRET"), { expiresIn: TOKEN_TTL });
}

// claimUserId lets a signup adopt a specific existing id as this new
// account's primary key, instead of a fresh random one -- the bootstrap
// path for a user_id that already owns real data from before real
// accounts existed (books/codex_entries/manuscript_chunks rows created
// with no login system behind them at all). Only succeeds the FIRST time
// anyone signs up with that id (the users table's primary key enforces
// this): once claimed, it's a normal password-protected account and no
// longer claimable by anyone else. Safe under this project's existing
// security model -- every one of those legacy ids was already completely
// unauthenticated (anyone who knew/guessed it could read/write it, per
// CLAUDE.md's documented "no auth on /api/v1/*" tradeoff), so turning the
// first successful claim into a real password doesn't remove protection
// that existed before; it only adds protection that wasn't there.
export async function signup(params: {
  email: string;
  password: string;
  displayName?: string;
  claimUserId?: string;
}): Promise<{ user: AuthUser; token: string }> {
  const email = params.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    throw new ValidationError("A valid email is required.");
  }
  if (!params.password || params.password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }
  if (params.claimUserId !== undefined && !UUID_RE.test(params.claimUserId)) {
    throw new ValidationError("claimUserId must be a valid UUID.");
  }

  const passwordHash = await bcrypt.hash(params.password, BCRYPT_ROUNDS);
  const insertRow: Record<string, unknown> = {
    email,
    password_hash: passwordHash,
    display_name: params.displayName?.trim() || null,
  };
  if (params.claimUserId !== undefined) {
    insertRow.id = params.claimUserId;
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("users").insert(insertRow).select("*").single();

  if (error) {
    if (error.code === "23505") {
      if (error.message?.includes("email") || error.details?.includes("email")) {
        throw new ConflictError("Email is already registered — log in instead.");
      }
      throw new ConflictError("That user id is already claimed by an existing account — log in instead.");
    }
    throw new Error(`Failed to create account: ${error.message}`);
  }

  const user = toAuthUser(data as UserRow);
  return { user, token: signToken(user) };
}

export async function login(params: { email: string; password: string }): Promise<{ user: AuthUser; token: string }> {
  const email = params.email.trim().toLowerCase();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("users").select("*").eq("email", email).maybeSingle();
  if (error) throw new Error(`Failed to look up account: ${error.message}`);

  // Same generic message whether the email doesn't exist or the password
  // is wrong -- distinguishing them lets a caller enumerate real emails.
  if (!data) throw new AuthError("Invalid email or password.");
  const row = data as UserRow;
  const matches = await bcrypt.compare(params.password, row.password_hash);
  if (!matches) throw new AuthError("Invalid email or password.");

  const user = toAuthUser(row);
  return { user, token: signToken(user) };
}

// Verifies a bearer token and re-fetches the account (rather than trusting
// the token payload alone) so a deleted account can't keep authenticating
// off an old, still-unexpired token.
export async function getUserFromToken(token: string): Promise<AuthUser> {
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, getEnvVar("JWT_SECRET")) as jwt.JwtPayload;
  } catch {
    throw new AuthError("Invalid or expired token.");
  }
  if (typeof payload.sub !== "string") {
    throw new AuthError("Invalid token payload.");
  }

  const supabase = getSupabaseClient();
  const { data, error } = await supabase.from("users").select("*").eq("id", payload.sub).maybeSingle();
  if (error) throw new Error(`Failed to look up account: ${error.message}`);
  if (!data) throw new AuthError("Account no longer exists.");
  return toAuthUser(data as UserRow);
}
