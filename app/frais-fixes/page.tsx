"use client";

import { useSession } from "@/lib/useSession";
import BarreOnglets from "@/components/BarreOnglets";

// Frais fixes : prêts hypothécaires (capital / intérêts), assurances et taxes.
// Page réservée dans la navigation ; le contenu arrive avec la version 0.8.6.
export default function PageFraisFixes() {
  const { session, pret } = useSession();
  if (!pret || !session) return null;

  return (
    <main className="page avec-onglets">
      <div className="entete">
        <h1>Frais fixes</h1>
      </div>
      <div className="carte">
        <strong>À venir dans la version 0.8.6</strong>
        <p className="aide">
          Par immeuble : prêts hypothécaires avec la ventilation capital et intérêts pour le T776,
          primes d&apos;assurance, taxes foncières et scolaires avec leurs dates d&apos;échéance.
        </p>
      </div>
      <BarreOnglets />
    </main>
  );
}
