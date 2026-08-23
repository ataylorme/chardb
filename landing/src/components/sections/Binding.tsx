import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Binding() {
    return (
        <Section id="binding" num="01" label="status">
            <SectionHeading>One organization-mutation slice works. The database does not.</SectionHeading>
            <SectionLead>
                A focused workerd harness carries a declared organization mutation from signed identity through Catalog
                authority and routing into Cdb policy enforcement and atomic execution. It uses test-seeded auth, not
                the packed chat application.
            </SectionLead>

            <BulletList
                items={[
                    "tested: explicit stable refs across emitted browser and Worker builds",
                    "tested: organization authority, tenant routing, write policy, and idempotent shard-local commit",
                    "unfinished: Better Auth sign-in-to-write application flow, public queries, snapshots, live results, and versioned migrations",
                ]}
            />

            <PullQuote>a working mutation slice, not a database release.</PullQuote>
        </Section>
    );
}
