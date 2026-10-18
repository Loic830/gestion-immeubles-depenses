"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function PageConnexion() {
  const router = useRouter();
  const [courriel, setCourriel] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  async function seConnecter(e: React.FormEvent) {
    e.preventDefault();
    setErreur(null);
    setEnvoi(true);
    const { error } = await supabase.auth.signInWithPassword({ email: courriel.trim(), password: motDePasse });
    setEnvoi(false);
    if (error) {
      setErreur("Courriel ou mot de passe incorrect.");
      return;
    }
    router.replace("/");
  }

  return (
    <main className="page">
      <div className="entete"><h1>Immeubles So-Max</h1></div>
      <form className="carte" onSubmit={seConnecter}>
        {erreur && <div className="message erreur">{erreur}</div>}
        <label htmlFor="courriel">Courriel</label>
        <input id="courriel" type="email" autoComplete="username" value={courriel}
               onChange={(e) => setCourriel(e.target.value)} required />
        <label htmlFor="mdp">Mot de passe</label>
        <input id="mdp" type="password" autoComplete="current-password" value={motDePasse}
               onChange={(e) => setMotDePasse(e.target.value)} required />
        <div style={{ marginTop: 18 }}>
          <button className="bouton principal plein" disabled={envoi}>
            {envoi ? "Connexion…" : "Se connecter"}
          </button>
        </div>
        <p className="aide">Les comptes sont créés dans Supabase (Authentication &gt; Users).</p>
      </form>
    </main>
  );
}
