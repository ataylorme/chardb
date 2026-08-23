import { BulletList, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function Binding() {
    return (
        <Section id="binding" num="01" label="status">
            <SectionHeading>The model is ahead of the runtime.</SectionHeading>
            <SectionLead>
                Chardb has working routing, colocation, operation-log, policy-compilation, and resharding components.
                The application mutation and query paths are not connected end to end yet.
            </SectionLead>

            <BulletList
                items={[
                    "tested: FK colocation and 16,384-vshard routing",
                    "tested: idempotent mutation log and Durable Object state machines",
                    "unfinished: domain mutations, initial queries, policy enforcement, and live results",
                ]}
            />

            <PullQuote>source code for review, not a database release.</PullQuote>
        </Section>
    );
}
