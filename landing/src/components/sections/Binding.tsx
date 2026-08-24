import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Binding() {
    return (
        <Section id="binding" num="01" label="status">
            <SectionHeading>One organization read/write slice works. The database does not.</SectionHeading>
            <SectionLead>
                A focused workerd harness carries declared organization mutations and explicit stable-ref queries
                through Catalog authority and routing into Cdb. The queries use organization authority, a partition key,
                and developer-declared server-side intent to reach one exact partition. A matching commit produces
                acknowledged replacement snapshots through durable Cdb and Gateway state. A separate clean-tarball smoke
                proves the packed chat slice through actual Better Auth anonymous sign-in and readback.
            </SectionLead>

            <BulletList
                items={[
                    "tested: explicit stable refs across emitted browser and Worker builds",
                    "tested: organization authority, tenant routing, write policy, and idempotent shard-local commit",
                    "tested: durable registration, invalidation, query rerun, replacement snapshots, and acknowledgements",
                    "tested: live table-dependency checks and role or membership revocation on dirty reruns",
                    "tested: two org-A clients update while an org-B query remains empty under policy",
                    "tested: clean-tarball replay and cross-organization denial for two signed-in principals",
                    "tested: staged live delivery after Gateway and Cdb reconstruct with a hibernated socket",
                    "unfinished: packed restart, resume replay, and versioned migrations",
                ]}
            />

            <PullQuote>a working read/write slice, not a database release.</PullQuote>
        </Section>
    );
}
