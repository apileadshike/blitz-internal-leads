import Link from "next/link";

type Page = "builder" | "jobs" | "leads" | "spend";
const LINKS: [Page, string, string][] = [
  ["builder", "/", "Builder"],
  ["jobs", "/jobs", "Jobs"],
  ["leads", "/leads", "Leads"],
  ["spend", "/spend", "Spend"],
];

export function Header({ active, right }: { active: Page; right?: React.ReactNode }) {
  return (
    <header>
      <h1>
        Blitz Lead Engine
        <nav>
          {LINKS.map(([id, href, label]) => (
            <Link key={id} href={href} className={active === id ? "on" : undefined}>{label}</Link>
          ))}
        </nav>
      </h1>
      {right}
    </header>
  );
}
