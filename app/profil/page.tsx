"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useSession } from "@/lib/useSession";
import { aujourdhuiIso, dateLisible } from "@/lib/dates";
import BarreOnglets from "@/components/BarreOnglets";

// Profil : mon compte (nom, cellulaire, courriel, mot de passe, déconnexion)
// et Actifs (immeubles : ajouter, ouvrir le détail, voir les immeubles vendus).

type Immeuble = {
  id: string;
  nom: string;
  adresse: string | null;
  actif: boolean;
  date_acquisition: string | null;
  date_vente: string | null;
};

export default function PageProfil() {
  const { session, pret } = useSession();

  // Mon compte
  const [nom, setNom] = useState("");
  const [cellulaire, setCellulaire] = useState("");
  const [courriel, setCourriel] = useState("");
  const [compteMsg, setCompteMsg] = useState<{ type: "succes" | "erreur"; texte: string } | null>(null);
  const [enregistrement, setEnregistrement] = useState(false);
  const [mdp, setMdp] = useState("");
  const [mdp2, setMdp2] = useState("");
  const [mdpMsg, setMdpMsg] = useState<{ type: "succes" | "erreur"; texte: string } | null>(null);

  // Actifs
  const [immeubles, setImmeubles] = useState<Immeuble[]>([]);
  const [nbLogements, setNbLogements] = useState<Record<string, number>>({});
  const [voirVendus, setVoirVendus] = useState(false);
  const [ajout, setAjout] = useState(false);
  const [nvNom, setNvNom] = useState("");
  const [nvAdresse, setNvAdresse] = useState("");
  const [nvDate, setNvDate] = useState(aujourdhuiIso());
  const [nvNb, setNvNb] = useState("");
  const [actifsMsg, setActifsMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const u = session.user;
    setNom((u.user_metadata?.nom as string | undefined) ?? "");
    setCellulaire((u.user_metadata?.cellulaire as string | undefined) ?? "");
    setCourriel(u.email ?? "");
    chargerImmeubles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  async function chargerImmeubles() {
    const [im, lg] = await Promise.all([
      supabase.from("immeubles").select("id, nom, adresse, actif, date_acquisition, date_vente")
        .is("deleted_at", null).order("nom"),
      supabase.from("logements").select("immeuble_id").is("deleted_at", null).eq("actif", true),
    ]);
    if (im.error) {
      // Migration 010 pas encore exécutée : on retombe sur les colonnes d'origine
      const repli = await supabase.from("immeubles").select("id, nom, adresse, actif, date_acquisition")
        .is("deleted_at", null).order("nom");
      setImmeubles(((repli.data ?? []) as Omit<Immeuble, "date_vente">[]).map((i) => ({ ...i, date_vente: null })));
      setActifsMsg("Exécuter supabase/010_profil_actifs.sql pour activer « Marquer comme vendu ».");
    } else {
      setImmeubles((im.data ?? []) as Immeuble[]);
    }
    const compte: Record<string, number> = {};
    for (const l of (lg.data ?? []) as { immeuble_id: string }[]) compte[l.immeuble_id] = (compte[l.immeuble_id] ?? 0) + 1;
    setNbLogements(compte);
  }

  async function enregistrerCompte(e: React.FormEvent) {
    e.preventDefault();
    setCompteMsg(null);
    setEnregistrement(true);
    const nouveauCourriel = courriel.trim();
    const changeCourriel = nouveauCourriel !== (session?.user.email ?? "");
    const { error } = await supabase.auth.updateUser({
      data: { nom: nom.trim(), cellulaire: cellulaire.trim() },
      ...(changeCourriel ? { email: nouveauCourriel } : {}),
    });
    setEnregistrement(false);
    if (error) {
      setCompteMsg({ type: "erreur", texte: `Enregistrement impossible : ${error.message}` });
      return;
    }
    setCompteMsg({
      type: "succes",
      texte: changeCourriel
        ? "Enregistré. Un lien de confirmation a été envoyé : le nouveau courriel s'appliquera après le clic."
        : "Enregistré.",
    });
  }

  async function changerMotDePasse(e: React.FormEvent) {
    e.preventDefault();
    setMdpMsg(null);
    if (mdp.length < 8) return setMdpMsg({ type: "erreur", texte: "8 caractères minimum." });
    if (mdp !== mdp2) return setMdpMsg({ type: "erreur", texte: "Les deux mots de passe ne sont pas identiques." });
    const { error } = await supabase.auth.updateUser({ password: mdp });
    if (error) return setMdpMsg({ type: "erreur", texte: `Changement impossible : ${error.message}` });
    setMdp("");
    setMdp2("");
    setMdpMsg({ type: "succes", texte: "Mot de passe changé." });
  }

  async function ajouterImmeuble(e: React.FormEvent) {
    e.preventDefault();
    setActifsMsg(null);
    const n = parseInt(nvNb, 10);
    if (!nvNom.trim()) return setActifsMsg("Le nom de l'immeuble est obligatoire.");
    if (!Number.isInteger(n) || n < 1 || n > 200) return setActifsMsg("Nombre de logements invalide.");
    const { data, error } = await supabase.from("immeubles")
      .insert({ nom: nvNom.trim(), adresse: nvAdresse.trim() || null, date_acquisition: nvDate || null, nb_logements: n })
      .select("id").single();
    if (error || !data) {
      return setActifsMsg(error?.code === "23505" ? "Un immeuble porte déjà ce nom." : `Ajout impossible : ${error?.message}`);
    }
    const logements = Array.from({ length: n }, (_, i) => ({ immeuble_id: data.id, numero: String(i + 1) }));
    const lg = await supabase.from("logements").insert(logements);
    if (lg.error) setActifsMsg(`Immeuble créé, mais les logements n'ont pas pu l'être : ${lg.error.message}`);
    setAjout(false);
    setNvNom("");
    setNvAdresse("");
    setNvNb("");
    await chargerImmeubles();
  }

  async function seDeconnecter() {
    if (!window.confirm("Se déconnecter de Immeubles So-Max ?")) return;
    await supabase.auth.signOut();
  }

  if (!pret || !session) return null;

  const affiches = immeubles
    .filter((i) => voirVendus || i.actif)
    .sort((a, b) => Number(b.actif) - Number(a.actif) || a.nom.localeCompare(b.nom, "fr-CA"));
  const nbVendus = immeubles.filter((i) => !i.actif).length;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Profil</h1>
      </div>

      <h2 className="immeuble-titre">Mon compte</h2>
      <form className="carte" onSubmit={enregistrerCompte}>
        {compteMsg && <div className={`message ${compteMsg.type}`}>{compteMsg.texte}</div>}
        <label htmlFor="nom">Nom</label>
        <input id="nom" autoComplete="name" value={nom} onChange={(e) => setNom(e.target.value)} />
        <label htmlFor="cell">Cellulaire</label>
        <input id="cell" type="tel" autoComplete="tel" inputMode="tel" value={cellulaire}
               onChange={(e) => setCellulaire(e.target.value)} placeholder="418 555-1234" />
        <label htmlFor="courriel">Courriel (connexion)</label>
        <input id="courriel" type="email" autoComplete="email" value={courriel}
               onChange={(e) => setCourriel(e.target.value)} required />
        <div style={{ marginTop: 16 }}>
          <button className="bouton principal plein" disabled={enregistrement}>
            {enregistrement ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>

      <details className="carte">
        <summary>Changer le mot de passe</summary>
        <form onSubmit={changerMotDePasse} style={{ marginTop: 8 }}>
          {mdpMsg && <div className={`message ${mdpMsg.type}`}>{mdpMsg.texte}</div>}
          <label htmlFor="mdp">Nouveau mot de passe</label>
          <input id="mdp" type="password" autoComplete="new-password" value={mdp} onChange={(e) => setMdp(e.target.value)} />
          <label htmlFor="mdp2">Confirmer</label>
          <input id="mdp2" type="password" autoComplete="new-password" value={mdp2} onChange={(e) => setMdp2(e.target.value)} />
          <div style={{ marginTop: 16 }}>
            <button className="bouton plein">Changer le mot de passe</button>
          </div>
        </form>
      </details>

      <div className="entete" style={{ margin: "24px 0 8px" }}>
        <h2 className="immeuble-titre" style={{ margin: 0 }}>Actifs</h2>
        {!ajout && <button className="bouton" onClick={() => setAjout(true)}>+ Ajouter</button>}
      </div>

      {actifsMsg && <div className="message alerte">{actifsMsg}</div>}

      {ajout && (
        <form className="carte" onSubmit={ajouterImmeuble}>
          <label htmlFor="nv-nom">Nom de l&apos;immeuble</label>
          <input id="nv-nom" value={nvNom} onChange={(e) => setNvNom(e.target.value)} placeholder="ex. Saint-Joseph" />
          <label htmlFor="nv-adr">Adresse</label>
          <input id="nv-adr" value={nvAdresse} onChange={(e) => setNvAdresse(e.target.value)} />
          <div className="rangee">
            <div>
              <label htmlFor="nv-date">Date d&apos;achat</label>
              <input id="nv-date" type="date" value={nvDate} onChange={(e) => setNvDate(e.target.value)} />
            </div>
            <div>
              <label htmlFor="nv-nb">Logements</label>
              <input id="nv-nb" inputMode="numeric" value={nvNb} onChange={(e) => setNvNb(e.target.value)} placeholder="6" />
            </div>
          </div>
          <p className="aide">Les logements sont numérotés 1, 2, 3… ; les numéros se modifient ensuite dans le détail.</p>
          <div className="rangee" style={{ marginTop: 12 }}>
            <button type="button" className="bouton" onClick={() => setAjout(false)}>Annuler</button>
            <button className="bouton principal">Ajouter l&apos;immeuble</button>
          </div>
        </form>
      )}

      <div className="carte">
        {affiches.length === 0 && <p className="aide">Aucun immeuble.</p>}
        {affiches.map((i) => (
          <Link key={i.id} href={`/profil/immeubles/${i.id}`} className="ligne-actif">
            <div className="infos">
              <div className="titre">{i.nom}</div>
              <div className="sous">
                {i.adresse || "Adresse à compléter"} · {nbLogements[i.id] ?? 0} logement(s)
                {!i.actif && i.date_vente ? ` · vendu le ${dateLisible(i.date_vente)}` : ""}
              </div>
            </div>
            {!i.actif && <span className="pastille vendu">Vendu</span>}
            <span aria-hidden="true">›</span>
          </Link>
        ))}
      </div>
      {nbVendus > 0 && (
        <button className="lien-filtres" onClick={() => setVoirVendus(!voirVendus)}>
          {voirVendus ? "Cacher les immeubles vendus" : `Afficher les immeubles vendus (${nbVendus})`}
        </button>
      )}

      <div style={{ marginTop: 32 }}>
        <button className="bouton plein lien-danger" onClick={seDeconnecter}>Se déconnecter</button>
      </div>

      <BarreOnglets />
    </main>
  );
}
