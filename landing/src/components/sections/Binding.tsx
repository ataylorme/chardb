import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Binding() {
    return (
        <Section id="binding" num="01" label="status">
            <SectionHeading>One organization read/write slice works. The database does not.</SectionHeading>
            <SectionLead>
                A focused workerd harness carries declared organization mutations and one explicit organization query
                through Catalog authority and routing into Cdb. The query has a stable ref, a partition key, and
                server-owned intent. It reaches one organization partition and returns one protocol-v3 snapshot,
                including an empty array when no rows match. The harness uses test-seeded auth, not the packed chat app.
            </SectionLead>

            <BulletList
                items={[
                    "tested: explicit stable refs across emitted browser and Worker builds",
                    "tested: organization authority, tenant routing, write policy, and idempotent shard-local commit",
                    "tested: one Catalog-authorized organization query, one Cdb read, and one initial snapshot",
                    "unfinished: server registration, live invalidation, replacement delivery, replay, and versioned migrations",
                ]}
            />

            <PullQuote>a working read/write slice, not a database release.</PullQuote>
        </Section>
    );
}
