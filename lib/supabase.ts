import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Message clair au lieu d'une erreur obscure si .env.local manque
  console.error("Variables NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY manquantes (.env.local).");
}

export const supabase = createClient(url ?? "http://localhost", anonKey ?? "cle-manquante", {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const BUCKET_RECUS = "recus";
