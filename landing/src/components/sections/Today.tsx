import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Today() {
    return (
        <Section id="today" num="01" label="the database">
            <SectionHeading>The whole organization path works end to end.</SectionHeading>
            <SectionLead>
                Scaffold a Worker, migrate it, sign in through Better Auth, create an organization, write and query
                rows, attach files, search vectors, and receive live replacements through the same typed model.
            </SectionLead>

            <BulletList
                items={[
                    "organization routing, membership, row policy, and column policy are enforced together",
                    "mutations are idempotent across reconnects and lost responses",
                    "the native env.DB binding runs the bounded select().from().where() path and registered operations",
                    "declared query callbacks and mutation handlers are erased into ref-only browser handles",
                    "live queries survive Gateway and shard reconstruction with exact bounded snapshot replay",
                    "forward maintenance-mode migrations resume from durable progress",
                    "files, vectors, and ordinary rows keep their identity when an organization range moves",
                    "Wrangler, Miniflare, Workerd, and real Cloudflare services exercise the same runtime contract",
                ]}
            />

            <p className="mt-8 max-w-2xl text-sm text-fg-muted">
                Chardb is experimental software. The first public query path is full-row, single-table, exact-partition,
                and capped at 100 rows. Backup, restore, automatic balancing, and cross-partition transactions are not
                part of this release.
            </p>

            <PullQuote>one model from sign-in to live data.</PullQuote>
        </Section>
    );
}
