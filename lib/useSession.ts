"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/** Redirige vers /login si personne n'est connecté. */
export function useSession() {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [pret, setPret] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setPret(true);
      if (!data.session) router.replace("/login");
    });
    const { data: abonnement } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      if (!s) router.replace("/login");
    });
    return () => abonnement.subscription.unsubscribe();
  }, [router]);

  return { session, pret };
}
