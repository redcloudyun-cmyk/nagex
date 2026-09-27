// R23.6E Phase C — structured pricing extraction contract.
// A source-agnostic shape both EvidencePackService sources and Browser
// fallback results are normalized into before extraction — extraction
// itself never needs to know which retrieval path produced a source.
export interface ExtractionSourceInput {
  sourceId: string;
  title: string;
  url: string;
  text: string;
  retrievedAt: string;
}

// Every fact the model proposes MUST carry the sourceId of the evidence it
// came from — a fact with no matching sourceId is rejected before it ever
// reaches comparison/synthesis (Phase C Section 3). Fields the source text
// does not actually support are null, never inferred.
export interface PricingExtractionCandidateFact {
  sourceId: string;
  competitor: string | null;
  planName: string | null;
  price: number | null;
  currency: string | null;
  billingPeriod: string | null;
  region: string | null;
  taxIncluded: boolean | null;
}
