import type { ReactNode } from "react";

type SpanProps = { children: ReactNode };

export const Kw = ({ children }: SpanProps) => <span className="text-syn-kw">{children}</span>;
export const Str = ({ children }: SpanProps) => <span className="text-syn-str">{children}</span>;
export const Id = ({ children }: SpanProps) => <span className="text-syn-ident">{children}</span>;
export const Fn = ({ children }: SpanProps) => <span className="text-syn-fn">{children}</span>;
export const Num = ({ children }: SpanProps) => <span className="text-syn-num">{children}</span>;
export const Cmt = ({ children }: SpanProps) => <span className="text-syn-cmt">{children}</span>;
export const P = ({ children }: SpanProps) => <span className="text-syn-punc">{children}</span>;
