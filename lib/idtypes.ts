// What a cell in an imported file is: shared by the server (detection) and the builder (applying).

export type IdType = "domain" | "company_url" | "person_url" | "email" | "phone";

/** Each kind of identifier, the list step that reads it, and how the builder names it. */
export const ID_TYPES: Record<IdType, { source: string; label: string }> = {
  domain: { source: "list_domains", label: "Company domains / websites" },
  company_url: { source: "list_company_urls", label: "LinkedIn company URLs" },
  person_url: { source: "list_person_urls", label: "LinkedIn profile URLs" },
  email: { source: "list_emails", label: "Work emails" },
  phone: { source: "list_phones", label: "Phone numbers (US)" },
};

const RX: Record<IdType, RegExp> = {
  person_url: /linkedin\.com\/in\/[^/\s?#]+/i,
  company_url: /linkedin\.com\/(company|school|showcase)\/[^/\s?#]+/i,
  email: /^[^@\s,;]+@[^@\s,;]+\.[a-z]{2,}$/i,
  phone: /^\+?[\d\s().-]{7,20}$/,
  domain: /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i,
};
/** When a column matches several kinds, the more specific one wins. */
export const ORDER: IdType[] = ["person_url", "company_url", "email", "phone", "domain"];
/** Header names that hint at a kind. */
export const HINTS: Record<IdType, RegExp> = {
  person_url: /linkedin|profile|person.*url/i,
  company_url: /company.*linkedin|linkedin.*company/i,
  email: /e-?mail/i,
  phone: /phone|mobile|tel|cell/i,
  domain: /domain|website|web\s*site|url|site/i,
};

export function kindOf(v: string): IdType | null {
  const s = v.trim();
  if (!s) return null;
  for (const t of ORDER) {
    if (t === "phone" && (s.replace(/\D/g, "").length < 7 || /[a-z]/i.test(s))) continue;
    if (RX[t].test(s)) return t;
  }
  return null;
}

/** Turn a cell into the value the list step expects. */
export function normalize(type: IdType, v: string): string {
  const s = v.trim();
  if (type === "domain") return s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  if (type === "email") return s.toLowerCase();
  if (type === "phone") return s.replace(/[^\d+]/g, "");
  return s.replace(/[?#].*$/, "").replace(/\/+$/, ""); // LinkedIn URL
}
