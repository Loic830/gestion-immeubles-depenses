"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { preparerFichier } from "@/lib/image";
import { televerserDocumentPret } from "@/lib/documents";

// Frais fixes (v0.9.18) : documents d'un prêt hypothécaire (lettre du prêteur, tableau d'amortissement,
// acte de prêt, renouvellement), pour référence. Même fonctionnement que les documents d'un bail :
// photo ou PDF, toucher pour ouvrir, × pour retirer une page ajoutée par erreur (suppression douce).

type Document = { id: string; storage_key: string; mime_type: string; nom_original: string | null; url: string | null };

export default function DocumentsPret({ hypothequeId, setErreur }: { hypothequeId: string; setErreur: (m: string | null) => void }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [disponible, setDisponible] = useState(true);
  const [televersement, setTeleversement] = useState<string | null>(null);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  const charger = useCallback(async () => {
    const { data, error } = await supabase
      .from("documents")
      .select("id, storage_key, mime_type, nom_original")
      .eq("hypotheque_id", hypothequeId)
      .is("deleted_at", null)
      .order("created_at");
    if (error) return setDisponible(false);  // migration 025 pas encore exécutée
    const liste = (data ?? []) as Omit<Document, "url">[];
    const urls = liste.length
      ? (await supabase.storage.from(BUCKET_RECUS).createSignedUrls(liste.map((d) => d.storage_key), 600)).data ?? []
      : [];
    setDocuments(liste.map((d) => ({ ...d, url: urls.find((u) => u.path === d.storage_key)?.signedUrl ?? null })));
  }, [hypothequeId]);

  useEffect(() => { charger(); }, [charger]);

  async function ajouter(fichiers: FileList | null) {
    if (!fichiers || fichiers.length === 0) return;
    setErreur(null);
    try {
      const liste = Array.from(fichiers);
      for (let i = 0; i < liste.length; i++) {
        setTeleversement(`Envoi ${i + 1} / ${liste.length}…`);
        await televerserDocumentPret(hypothequeId, await preparerFichier(liste[i]));
      }
      await charger();
    } catch (e) {
      setErreur(e instanceof Error ? e.message : String(e));
    } finally {
      setTeleversement(null);
      if (champPhoto.current) champPhoto.current.value = "";
      if (champFichier.current) champFichier.current.value = "";
    }
  }

  async function retirer(d: Document, numero: number) {
    if (!window.confirm(`Retirer la page ${numero} des documents du prêt ? (ajoutée par erreur)`)) return;
    setErreur(null);
    const { error } = await supabase.from("documents").update({ deleted_at: new Date().toISOString() }).eq("id", d.id);
    if (error) return setErreur(error.message);
    await charger();
  }

  if (!disponible) {
    return <p className="aide" style={{ marginTop: 8 }}>Documents du prêt : exécuter la migration 025 dans Supabase.</p>;
  }

  return (
    <details style={{ marginTop: 8 }}>
      <summary>Documents du prêt ({documents.length})</summary>
      <p className="aide">Lettre du prêteur, tableau d&apos;amortissement, acte de prêt, renouvellement : photo ou PDF, pour référence.</p>
      <div className="rangee">
        <button type="button" className="bouton principal" onClick={() => champPhoto.current?.click()} disabled={televersement !== null}>
          {televersement ?? (documents.length ? "+ Page" : "Photo")}
        </button>
        <button type="button" className="bouton" onClick={() => champFichier.current?.click()} disabled={televersement !== null}>
          Fichier ou PDF
        </button>
      </div>
      <input ref={champPhoto} type="file" accept="image/*" capture="environment" hidden onChange={(e) => ajouter(e.target.files)} />
      <input ref={champFichier} type="file" accept="image/*,application/pdf" multiple hidden onChange={(e) => ajouter(e.target.files)} />
      {documents.length > 0 && (
        <div className="photos">
          {documents.map((d, i) => (
            <div key={d.id} className="vignette" role="button" tabIndex={0} style={{ cursor: "pointer" }}
                 onClick={() => d.url && window.open(d.url, "_blank")}>
              {d.mime_type === "application/pdf" || !d.url ? "PDF" : <img src={d.url} alt={`Document du prêt, page ${i + 1}`} />}
              <button type="button" aria-label={`Retirer la page ${i + 1}`}
                      onClick={(e) => { e.stopPropagation(); retirer(d, i + 1); }}>×</button>
            </div>
          ))}
        </div>
      )}
      {documents.length > 0 && <p className="aide">Toucher pour ouvrir, × pour retirer une page ajoutée par erreur.</p>}
    </details>
  );
}
