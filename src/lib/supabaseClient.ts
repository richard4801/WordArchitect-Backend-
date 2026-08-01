import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnvVar } from "./env.js";

let client: SupabaseClient | undefined;

export function getSupabaseClient(): SupabaseClient {
  if (!client) {
    client = createClient(getEnvVar("SUPABASE_URL"), getEnvVar("SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { persistSession: false },
    });
  }
  return client;
}
