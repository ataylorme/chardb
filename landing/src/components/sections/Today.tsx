import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Today() {
    return (
        <Section id="today" num="01" label="working today">
            <SectionHeading>The tenant-shaped core works end to end.</SectionHeading>
            <SectionLead>
                A clean package can scaffold and build a Worker, apply a packaged migration, authenticate through Better
                Auth, isolate organizations, commit mutations, and deliver live replacement snapshots. Workerd tests
                then break connections, reconstruct Durable Objects, and require the same state to recover.
            </SectionLead>

            <BulletList
                items={[
                    "organization routing, membership, row policy, and column policy are enforced together",
                    "mutations are idempotent across reconnects and lost responses",
                    "the native env.DB binding runs typed server queries and mutations without internal binding config",
                    "live queries survive Gateway and shard reconstruction with exact bounded snapshot replay",
                    "forward maintenance-mode migrations resume from durable progress",
                    "frozen scale profiles prove convergence, isolation, replay, and counter invariants under churn",
                ]}
            />

            <p className="mt-8 max-w-2xl text-sm text-fg-muted">
                This is still experimental software. Files, vectors, general query shapes, automatic resharding, and the
                raw Drizzle-over-RPC builders are not supported product paths yet.
            </p>

            <PullQuote>the proof is real. the product is unfinished.</PullQuote>
        </Section>
    );
}
