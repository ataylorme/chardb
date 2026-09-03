# Why I built CharDB.

I want to share the inspiration for why I built this and what I think it could become.

## I ❤️ Better Auth

I immediately fell in love with the [Better Auth](https://better-auth.com/) library. Coming from NextAuth, it felt like a much more scalable foundation. I bought into the larger idea immediately: an auth system that could become part of the application, not just an OAuth login screen.

Building the [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare) plugin connected that with my love for deploying to Cloudflare Workers and using KV, R2, and D1. It filled a void in Cloudflare, which doesn't have an auth service. When you deploy Better Auth Cloudflare, it feels native to developing with Workers. I especially like using it with Drizzle because it handles my D1 migrations well.

## Cloudflare is still missing an auto-scaling database

But there's a limit. D1 has a 10 gigabyte limit. Besides an auth service, Cloudflare is also missing an auto-scaling database. You can use D1. You can use Durable Objects. Theoretically, you could use KV at a much larger scale, but it makes data harder to query in the ways real apps need. You definitely don't want to store data in R2 and try to query it at scale.

Realistically, you have to use Hyperdrive to bring in a Postgres or MySQL database that you host on AWS or somewhere else. Not only is this expensive, it feels clunky, and the network hops are less than desirable.

## Why not use auth to shard organization data?

I came up with the idea to combine my auth with my need for a scalable database and use organization identity as the stable placement key. One organization operation still belongs to one physical Cdb transaction. Range movement can redistribute organizations between Cdbs without changing application keys, but it does not split one organization's rows across several Cdbs today.

Because we're built on Durable Objects and SQLite, you can run real queries and get live updates through the same organization route. Durable Objects already provide the SQLite transaction and WebSocket primitives that path needs.

## Files should be a first-class data type

I think the next big enabler is that Better Auth Cloudflare has already mastered how to map a user and their database records to files stored in R2. I've always dreamed of a database that had files as a first-class object, as a column data type.

It has always been a pain to store a key and then have to look up the file somewhere else. Can't I just get it from the database? Can't the database route that way for me? CharDB treats organization-owned files and vectors as first-class schema values. The row keeps an opaque identity while the database handles policy, delivery, and cleanup. It's 2026. These should feel native.

## It has to feel native

The idea is a database that can add physical Cdbs behind stable organization routing. The only remaining question is how to host it. CharDB lives as an extension of Wrangler, Drizzle, and Miniflare, so you can use it within an existing Cloudflare project and test it locally with Miniflare.

I'm especially proud of how it extends the Drizzle migration experience. That was a key requirement for me. When you grow something big, already have users, and need to make changes, you need something you can rely on. For me, that has always been Drizzle. `chardb migrations generate` now inspects the application's Drizzle and Better Auth definitions twice in fresh processes. It writes an immutable initial snapshot and conservative sequential additive migrations without a second hand-maintained schema. The runner resumes interrupted work, fences old code, and publishes the new epoch only after every shard finishes.

This is an experimental database, but the developer experience is something I've always dreamed of, and the initial performance measurements are promising. The package is built to run the same way through Wrangler, local Workerd, and real Cloudflare services. I think this could be something special with community contributions.

> this is an experimental database, but the developer experience is something I've always dreamed of.

## P.S. Cloudflare

If you would just release an auto-scaling database that's as amazing as the rest of your pricing, I would end this now, delete this repo, and you would never hear from me about this again.
