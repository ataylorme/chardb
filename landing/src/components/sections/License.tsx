import { BulletList, InlineCode, PullQuote, Section, SectionHeading, SectionLead } from "../Section";

export function License() {
    return (
        <Section id="license" num="06" label="license">
            <SectionHeading>Yours.</SectionHeading>
            <SectionLead>
                MIT-licensed, self-hosted, and deployed by <InlineCode>wrangler deploy</InlineCode>. Your Cloudflare
                account holds the data. Your repo holds the code.
            </SectionLead>
            <BulletList items={["MIT, end to end", "runs on your account", "ships with your worker"]} />
            <PullQuote>your account. your data. your code.</PullQuote>
        </Section>
    );
}
