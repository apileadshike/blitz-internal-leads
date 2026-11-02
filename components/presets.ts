// Ready-made recipes (from Blitz's playbooks).
export type StepConfig = { step: string; params?: Record<string, any> };
export type Pipeline = {
  steps: StepConfig[];
  maxItems?: number;
  concurrency?: number;
  maxRecords?: number;
  skipSeenPeople?: boolean;
  skipSeenCompanies?: boolean;
  useCache?: boolean;
};

export const PRESETS: Record<string, Pipeline> = {
  "ICP list: Find People → Email → Phone": {
    steps: [
      { step: "people_search", params: {
        company: { industry: { include: ["Software Development"] }, employee_range: ["11-50", "51-200"], hq: { country_code: ["US"] } },
        people: { job_level: ["C-Team", "VP", "Director"], location: { country_code: ["US"] } } } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Company first: Company Search → Waterfall → Email → Phone": {
    steps: [
      { step: "company_search", params: { company: { industry: { include: ["Software Development"] }, employee_range: ["11-50", "51-200"], hq: { country_code: ["US"] } } } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["Head of Marketing", "CMO", "VP Marketing"], exclude_title: ["assistant", "intern"] },
        { include_title: ["[CEO]", "Founder", "Co-Founder"] },
      ] } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Hiring signal: TAM by Jobs → Waterfall → Email": {
    steps: [
      { step: "tam_by_jobs", params: { job: { title: { include: ["SDR", "Sales Development Representative"] } }, company: { hq: { country_code: { include: ["US"] } } } } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["VP Sales", "Head of Sales", "CRO", "Chief Revenue Officer"] },
        { include_title: ["[CEO]", "Founder"] },
      ] } },
      { step: "find_email", params: {} },
    ],
  },
  "ABM: Paste domains → Company Enrichment → Waterfall → Email → Phone": {
    steps: [
      { step: "list_domains", params: { list: "stripe.com\nnotion.so\nlinear.app" } },
      { step: "company_enrichment", params: {} },
      { step: "waterfall_icp", params: { max_results: 3, cascade: [
        { include_title: ["CRO", "VP Sales", "Head of Growth"] },
        { include_title: ["Sales Director", "Director of Business Development"] },
      ] } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Inbound qualifier: Paste emails → Company Enrichment → ICP Fit": {
    steps: [
      { step: "list_emails", params: { list: "" } },
      { step: "company_enrichment", params: {} },
      { step: "icp_fit", params: { company_sizes: ["11-50", "51-200", "201-500"], countries: ["US"], exclude_title_keywords: ["intern", "student"] } },
    ],
  },
  "Job-change tracker: Saved people → Job Change Check": {
    steps: [
      { step: "saved_people", params: {} },
      { step: "job_change_check", params: { only_changed: true } },
    ],
  },
  "Buying committee: Paste company URLs → 3 roles → Email → Phone": {
    steps: [
      { step: "list_company_urls", params: { list: "https://www.linkedin.com/company/stripe" } },
      { step: "buying_committee", params: {
        decision_makers: ["[CEO]", "Founder", "CRO", "VP Sales"],
        champions: ["Head of Sales", "Sales Director", "Head of Growth"],
        users: ["SDR", "BDR", "Account Executive"],
        per_role: 1 } },
      { step: "find_email", params: {} },
      { step: "find_phone", params: {} },
    ],
  },
  "Hiring-signal alert: TAM by Jobs → Only new → Waterfall → Email": {
    steps: [
      { step: "tam_by_jobs", params: { job: { title: { include: ["SDR", "Sales Development Representative"] } }, company: { hq: { country_code: { include: ["US"] } } } } },
      { step: "only_new", params: { watch_name: "sdr-hiring-us", on: "company" } },
      { step: "waterfall_icp", params: { max_results: 2, cascade: [
        { include_title: ["VP Sales", "Head of Sales", "CRO"] },
        { include_title: ["[CEO]", "Founder"] },
      ] } },
      { step: "find_email", params: {} },
    ],
  },
  "Export: Find People → Email → Google Sheet": {
    steps: [
      { step: "people_search", params: { company: { industry: { include: ["Software Development"] }, hq: { country_code: ["US"] } }, people: { job_level: ["C-Team"] } } },
      { step: "find_email", params: {} },
      { step: "send_google_sheet", params: { apps_script_url: "" } },
    ],
  },
};
