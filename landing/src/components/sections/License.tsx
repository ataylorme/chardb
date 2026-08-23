import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function License() {
    return (
        <Section id="license" num="06" label="license">
            <SectionHeading>Open for inspection.</SectionHeading>
            <SectionLead>
                The code is MIT-licensed. It targets <InlineCode>wrangler</InlineCode> and Cloudflare Durable Objects,
                but it is not ready for production data.
            </SectionLead>
            <BulletList items={["read the implementation", "run the tests", "challenge the tenant-boundary model"]} />
            <PullQuote>publish the experiment. earn the product claims later.</PullQuote>
        </Section>
    );
}
