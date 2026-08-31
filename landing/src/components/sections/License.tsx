import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function License() {
    return (
        <Section id="license" num="07" label="license">
            <SectionHeading>Yours to inspect and run.</SectionHeading>
            <SectionLead>
                The code is MIT-licensed and runs in your Cloudflare account through <InlineCode>wrangler</InlineCode>,
                Durable Objects, R2, and Vectorize.
            </SectionLead>
            <BulletList items={["read the implementation", "run the tests", "challenge the tenant-boundary model"]} />
            <PullQuote>your account. your data. your code.</PullQuote>
        </Section>
    );
}
