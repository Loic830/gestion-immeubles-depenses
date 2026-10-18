"use client";

import { useEffect, useState } from "react";
import { activerPush, desactiverPush, etatPush, type EtatPush } from "@/lib/push";

// « Sur ce téléphone » : activer les notifications poussées (v0.8.9).

const TEXTES: Record<EtatPush, string> = {
  "non-supporte": "Ce navigateur ne reçoit pas les notifications poussées. Elles restent visibles sous la cloche.",
  "a-installer": "Pour les recevoir sur l'iPhone : ouvrir l'app dans Safari > Partager > « Sur l'écran d'accueil », puis l'ouvrir depuis l'icône et revenir ici.",
  "non-configure": "L'envoi au téléphone n'est pas encore configuré (Loïc : clés VAPID dans Vercel, voir README).",
  "refuse": "Notifications refusées sur ce téléphone. Pour les permettre : Réglages > Notifications > So-Max.",
  "inactif": "Recevoir les notifications sur ce téléphone, même quand l'app est fermée.",
  "actif": "Activées sur ce téléphone.",
};

export default function ActivationPush() {
  const [etat, setEtat] = useState<EtatPush | null>(null);
  const [occupe, setOccupe] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(() => { etatPush().then(setEtat).catch(() => setEtat("non-supporte")); }, []);

  async function activer() {
    setOccupe(true);
    setErreur(null);
    try {
      const msg = await activerPush();
      if (msg) setErreur(msg);
    } catch (e) {
      setErreur((e as Error).message);
    }
    setEtat(await etatPush());
    setOccupe(false);
  }

  async function desactiver() {
    setOccupe(true);
    await desactiverPush().catch(() => {});
    setEtat(await etatPush());
    setOccupe(false);
  }

  if (!etat) return null;
  return (
    <div className="carte">
      <strong>Sur ce téléphone</strong>
      <p className="aide">{TEXTES[etat]}</p>
      {erreur && <div className="message erreur" style={{ marginTop: 8 }}>{erreur}</div>}
      {etat === "inactif" && (
        <button type="button" className="bouton principal plein" style={{ marginTop: 8 }} disabled={occupe} onClick={activer}>
          Activer les notifications
        </button>
      )}
      {etat === "actif" && (
        <button type="button" className="bouton plein" style={{ marginTop: 8 }} disabled={occupe} onClick={desactiver}>
          Désactiver sur ce téléphone
        </button>
      )}
    </div>
  );
}
