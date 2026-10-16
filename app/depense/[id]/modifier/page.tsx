"use client";

import { useParams } from "next/navigation";
import FormulaireDepense from "@/components/FormulaireDepense";

export default function ModifierDepense() {
  const { id } = useParams<{ id: string }>();
  return <FormulaireDepense depenseId={id} />;
}
