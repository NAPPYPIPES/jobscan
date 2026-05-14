// Slug → primary domain map, used by the matches view to resolve a
// logo URL per company. Kept separate from TARGETS itself: scan / DB /
// email don't care about the domain, only the UI does. Missing entries
// fall back to a letter-circle placeholder in CompanyHeader.
//
// Add an entry here whenever you add a new company to TARGETS — without
// it the company-grouped UI will still render fine, just with a letter
// fallback instead of the favicon-derived logo.
export const COMPANY_DOMAINS: Record<string, string> = {
  // Greenhouse
  anthropic:   "anthropic.com",
  stripe:      "stripe.com",
  databricks:  "databricks.com",
  hebbia:      "hebbia.ai",
  gleanwork:   "glean.com",
  carta:       "carta.com",
  affirm:      "affirm.com",
  brex:        "brex.com",
  lattice:     "lattice.com",
  cresta:      "cresta.com",
  // Ashby
  notion:      "notion.so",
  openai:      "openai.com",
  writer:      "writer.com",
  ramp:        "ramp.com",
  mercury:     "mercury.com",
  plaid:       "plaid.com",
  sierra:      "sierra.ai",
  decagon:     "decagon.ai",
  huggingface: "huggingface.co",
  // Lever
  rippling:    "rippling.com",
  // Workday
  salesforce:  "salesforce.com",
  adobe:       "adobe.com",
};

// Google's favicon service. Reliable, no API key, returns the brand
// favicon at the requested size — for most modern companies that's the
// actual logo mark since they use a high-res favicon. We request 64 so
// a 32px square is sharp on retina.
export function logoUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}
