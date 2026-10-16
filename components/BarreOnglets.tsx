"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Barre d'onglets du bas.
const ONGLETS = [
  { href: "/loyers", libelle: "Loyers", icone: "💵", actif: (p: string) => p.startsWith("/loyers") },
  { href: "/", libelle: "Dépenses", icone: "🧾", actif: (p: string) => p === "/" || p.startsWith("/depense") },
  { href: "/baux", libelle: "Baux", icone: "🔑", actif: (p: string) => p.startsWith("/baux") },
];

export default function BarreOnglets() {
  const chemin = usePathname() ?? "/";
  return (
    <nav className="barre-onglets" aria-label="Sections">
      {ONGLETS.map((o) => (
        <Link key={o.href} href={o.href} className={o.actif(chemin) ? "actif" : ""}>
          <span aria-hidden="true">{o.icone}</span>
          {o.libelle}
        </Link>
      ))}
    </nav>
  );
}
