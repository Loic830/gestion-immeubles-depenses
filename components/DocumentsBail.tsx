"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, BUCKET_RECUS } from "@/lib/supabase";
import { preparerFichier } from "@/lib/image";
import { DOCUMENTS_BAIL, televerserDocument, type TypeDocumentBail } from "@/lib/documents";

// Fiche du bail : une section de documents (bail signé, enquête de crédit ou règlements d'immeuble).
// Photo ou PDF, toucher pour ouvrir, × pour retirer une page ajoutée par erreur (suppression douce).

type Document = { id: string; storage_key: string; mime_type: string; url: string | null };

export default function DocumentsBail({ bailId, type, setErreur, titre, aide }: {
  bailId: string; type: TypeDocumentBail; setErreur: (m: string | null) => void;
  titre?: string; aide?: string;  // v0.9.5 : « Renouvellement signé », « Entente de cession »
}) {
  const base = DOCUMENTS_BAIL.find((d) => d.type === type)!;
  const def = { ...base, titre: titre ?? base.titre, aideFiche: aide ?? base.aideFiche, bouton: titre ? "Ajouter une photo" : base.bouton };
  const [documents, setDocuments] = useState<Document[]>([]);
  const [televersement, setTeleversement] = useState<string | null>(null);
  const champPhoto = useRef<HTMLInputElement>(null);
  const champFichier = useRef<HTMLInputElement>(null);

  const charger = useCallback(async () => {
    const { data } = await supabase
      .from("documents")
      .select("id, storage_key, mime_type")
      .eq("bail_id", bailId)
      .eq("type", type)
      .is("deleted_at", null)
      .order("created_at");
    const liste = (data ?? []) as Omit<Document, "url">[];
    const urls = liste.length
      ? (await supabase.storage.from(BUCKET_RECUS).createSignedUrls(liste.map((d) => d.storage_key), 600)).data ?? []
      : [];
    setDocuments(liste.map((d) => ({ ...d, url: urls.find((u) => u.path === d.storage_key)?.signedUrl ?? null })));
  }, [bailId, type]);

  useEffect(() => { charger(); }, [charger]);

  async function ajouter(fichiers: FileList | null) {
    if (!fichiers || fichiers.length === 0) return;
    setErreur(null);
    try {
      const liste = Array.from(fichiers);
      for (let i = 0; i < liste.length; i++) {
        setTeleversement(`Envoi ${i + 1} / ${liste.length}…`);
        await televerserDocument(bailId, type, await preparerFichier(liste[i]));
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
    if (!window.confirm(`Retirer la page ${numero} (${def.titre.toLowerCase()}) ? (ajoutée par erreur)`)) return;
    setErreur(null);
    const { error } = await supabase.from("documents").update({ deleted_at: new Date().toISOString() }).eq("id", d.id);
    if (error) return setErreur(error.message);
    await charger();
  }

  return (
    <section className="carte">
      <strong>{def.titre}</strong>
      <p className="aide">{def.aideFiche}</p>
      <div className="rangee">
        <button className="bouton principal" onClick={() => champPhoto.current?.click()} disabled={televersement !== null}>
          {televersement ?? (documents.length ? "+ Page" : def.bouton)}
        </button>
        <button className="bouton" onClick={() => champFichier.current?.click()} disabled={televersement !== null}>
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
              {d.mime_type === "application/pdf" || !d.url ? "PDF" : <img src={d.url} alt={`${def.nomPage}, page ${i + 1}`} />}
              <button type="button" aria-label={`Retirer la page ${i + 1}`}
                      onClick={(e) => { e.stopPropagation(); retirer(d, i + 1); }}>×</button>
            </div>
          ))}
        </div>
      )}
      {documents.length > 0 && <p className="aide">{documents.length} page{documents.length > 1 ? "s" : ""} · toucher pour ouvrir, × pour retirer une page ajoutée par erreur.</p>}
    </section>
  );
}
